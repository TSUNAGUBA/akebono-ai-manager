import http from 'node:http';
import { AppError, ERROR_CODES, isAppError } from './errors.js';
import { logger } from './logger.js';

export interface RouteContext {
  /** パスの RegExp キャプチャ(named groups) */
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
) => Promise<void> | void;

export interface Route {
  method: 'GET' | 'POST';
  /** 完全一致パス、または named group を含む RegExp */
  path: string | RegExp;
  handler: RouteHandler;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MiB

/** リクエストボディを Buffer として読む。サイズ超過は AIM-3103(413)。 */
async function readRawBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディが大きすぎます', {
        status: 413,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** リクエストボディを UTF-8 文字列として読む。サイズ超過は AIM-3103(413)。 */
async function readRawBody(req: http.IncomingMessage): Promise<string> {
  return (await readRawBuffer(req, MAX_BODY_BYTES)).toString('utf8');
}

/** JSON ボディを読む。サイズ超過・不正 JSON は AIM-3103。 */
export async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  if (raw === '') {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディが空です', { status: 400 });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディが JSON として不正です', {
      status: 400,
      cause: err,
    });
  }
}

/**
 * 任意の JSON ボディを読む。空ボディは undefined を返す(ボディ省略可のエンドポイント用。
 * 例: batch の /jobs/{name} — Cloud Scheduler はボディなしで POST する)。
 * 不正 JSON・サイズ超過は readJsonBody と同じく AIM-3103。
 */
export async function readOptionalJsonBody<T = unknown>(
  req: http.IncomingMessage,
): Promise<T | undefined> {
  const raw = await readRawBody(req);
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディが JSON として不正です', {
      status: 400,
      cause: err,
    });
  }
}

/**
 * フォームボディ(application/x-www-form-urlencoded)を読む。
 * 空ボディは空の URLSearchParams を返す(必須項目の検証は呼び出し側の責務)。
 */
export async function readFormBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const raw = await readRawBody(req);
  return new URLSearchParams(raw);
}

/** multipart/form-data のファイルパート。 */
export interface MultipartFile {
  /** フォームのフィールド名(input の name 属性)。 */
  field: string;
  /** 送信されたファイル名(パス要素は除去済み)。 */
  fileName: string;
  content: Buffer;
}

export interface MultipartFormBody {
  /** ファイル以外のフィールド(hidden input 等)。CSRF 検証にそのまま使える。 */
  fields: URLSearchParams;
  files: MultipartFile[];
}

/** ファイルアップロードを含むリクエスト全体の上限(1ファイルの上限は呼び出し側で検証する)。 */
const MULTIPART_MAX_BYTES = 4 * 1024 * 1024; // 4MiB
/** パート数の上限(フィールド+ファイルの合計。フォーム偽装による資源消費の抑止)。 */
const MULTIPART_MAX_PARTS = 40;

/** リクエストが multipart/form-data かどうか(ファイルアップロードのフォーム判定)。 */
export function isMultipartRequest(req: http.IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
}

function multipartInvalid(message: string): AppError {
  return new AppError(ERROR_CODES.REQUEST_BODY_INVALID, message, { status: 400 });
}

/** Content-Disposition の name="..." / filename="..." を取り出す(\" と \\ のみ復元)。 */
function dispositionParam(disposition: string, param: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${param}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(disposition);
  if (m?.[1] === undefined) return undefined;
  return m[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

/**
 * フォームボディ(multipart/form-data)を読む。RFC 7578 のうちブラウザのフォーム送信が
 * 使う範囲(boundary 区切り・Content-Disposition の name / filename)のみ対応する
 * (外部依存を増やさない最小実装。呼び出し元は自前のフォームに限られる)。
 * - 全体サイズ超過は AIM-3103(413)、構文不正・パート数超過は AIM-3103(400)
 * - filename のパス要素(/ や \)はファイル名部分のみに切り詰める
 * - ファイル未選択(filename が空)のパートはファイルとして扱わない
 * - 既知の制限: パート本文のバイト列が「CRLF + デリミタ」と完全一致する箇所を含む場合は
 *   形式不正(400)として全体を拒否する(誤分割で内容を壊すより安全側に倒す。
 *   ブラウザの boundary はランダム生成のため実運用で衝突しない)
 */
export async function readMultipartFormBody(
  req: http.IncomingMessage,
): Promise<MultipartFormBody> {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2])?.trim();
  if (boundary === undefined || boundary === '') {
    throw multipartInvalid('multipart/form-data の boundary がありません');
  }
  // RFC 2046 §5.1.1 の上限(70 文字)。逸脱した長大 boundary は Buffer.indexOf の
  // 最悪計算量(O(n·m))を突いた CPU 消費(イベントループ停止)に使えるため必ず弾く
  if (boundary.length > 70) {
    throw multipartInvalid('multipart/form-data の boundary が長すぎます');
  }

  const body = await readRawBuffer(req, MULTIPART_MAX_BYTES);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new URLSearchParams();
  const files: MultipartFile[] = [];

  // 先頭のデリミタ(preamble は無視する)
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw multipartInvalid('multipart/form-data の形式が不正です');
  cursor += delimiter.length;

  for (let part = 0; ; part += 1) {
    // デリミタ直後: "--" なら終端、"\r\n" ならパート開始
    // (終端判定を先に行う — 上限パート数ちょうどの正当なボディを弾かない)
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') return { fields, files };
    if (part >= MULTIPART_MAX_PARTS) {
      throw multipartInvalid('multipart/form-data のパート数が多すぎます');
    }
    if (body.subarray(cursor, cursor + 2).toString('latin1') !== '\r\n') {
      throw multipartInvalid('multipart/form-data の形式が不正です');
    }
    cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) throw multipartInvalid('multipart/form-data のヘッダーが不正です');
    const headerLines = body.subarray(cursor, headerEnd).toString('utf8').split('\r\n');
    const disposition = headerLines.find((l) => l.toLowerCase().startsWith('content-disposition:'));
    if (disposition === undefined) {
      throw multipartInvalid('multipart/form-data に Content-Disposition がありません');
    }
    const name = dispositionParam(disposition, 'name');
    if (name === undefined) {
      throw multipartInvalid('multipart/form-data のフィールド名がありません');
    }
    const rawFileName = dispositionParam(disposition, 'filename');

    const contentStart = headerEnd + 4;
    // パート本文は「\r\n + デリミタ」まで(本文中の CRLF 単体は保全される。
    // 「CRLF + デリミタ」と完全一致する本文は関数ドキュメント記載のとおり全体拒否)
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), contentStart);
    if (next === -1) throw multipartInvalid('multipart/form-data の終端がありません');
    const content = body.subarray(contentStart, next);
    cursor = next + 2 + delimiter.length;

    if (rawFileName === undefined) {
      fields.append(name, content.toString('utf8'));
      continue;
    }
    // パス付きで送るブラウザ・OS に備えてファイル名部分のみを使う
    const fileName = rawFileName.split(/[/\\]/).pop() ?? '';
    if (fileName === '') continue; // ファイル未選択の空パート
    files.push({ field: name, fileName, content: Buffer.from(content) });
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end(html);
}

export function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(text);
}

function matchRoute(
  route: Route,
  method: string,
  pathname: string,
): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  if (typeof route.path === 'string') {
    return route.path === pathname ? {} : undefined;
  }
  const m = route.path.exec(pathname);
  return m ? { ...m.groups } : undefined;
}

/**
 * 各サービス共通の HTTP サーバー。
 * - GET /health を標準装備
 *   (注意: /healthz は Cloud Run のフロントエンドが予約しており、コンテナに届く前に
 *    Google の 404 が返るため使用しないこと)
 * - AppError は status + エラーコード付き JSON に変換
 * - 想定外エラーは 500 とし詳細はログのみに残す
 */
export function createAppServer(routes: Route[]): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(routes, req, res);
  });
}

async function handleRequest(
  routes: Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();
  try {
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    for (const route of routes) {
      const params = matchRoute(route, method, url.pathname);
      if (params !== undefined) {
        await route.handler(req, res, { params, url });
        return;
      }
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  } catch (err) {
    if (isAppError(err)) {
      logger.error('リクエスト処理でエラー', err, { path: url.pathname });
      if (!res.headersSent) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      }
    } else {
      logger.error('リクエスト処理で想定外のエラー', err, { path: url.pathname });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: 'internal error' } });
      }
    }
  } finally {
    logger.info('request', {
      httpRequest: {
        requestMethod: method,
        requestUrl: url.pathname,
        status: res.statusCode,
        latency: `${((Date.now() - started) / 1000).toFixed(3)}s`,
      },
    });
  }
}

/** サーバー起動の共通処理。PORT は Cloud Run が注入する。 */
export function startServer(server: http.Server, serviceName: string): void {
  const port = Number.parseInt(process.env['PORT'] ?? '8080', 10);
  server.listen(port, () => {
    logger.info(`${serviceName} listening`, { port });
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      logger.info(`${signal} received, shutting down`);
      server.close(() => process.exit(0));
      // Cloud Run の猶予期間内に閉じない場合の保険
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
