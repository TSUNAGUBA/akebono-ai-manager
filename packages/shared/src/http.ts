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

/** JSON ボディを読む。サイズ超過・不正 JSON は AIM-3103。 */
export async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディが大きすぎます', {
        status: 413,
      });
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
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
