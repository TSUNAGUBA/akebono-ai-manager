import type http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import {
  AppError,
  ERROR_CODES,
  logger,
  query,
  requireEnv,
} from '@ai-manager/shared';
import type pg from 'pg';

/**
 * Google Chat からのリクエスト検証。
 * Chat アプリの構成方式により、Google は2種類のトークンを送ってくる:
 *
 * 1. 新方式(Workspace アドオン基盤経由。User-Agent: Google-gsuiteaddons):
 *    accounts.google.com 発行の ID トークン。audience はエンドポイント URL
 *    (またはプロジェクト番号)、email はアドオン基盤のサービスエージェント
 *    `service-<プロジェクト番号>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
 *    または `chat@system.gserviceaccount.com`
 * 2. 旧方式: chat@system.gserviceaccount.com が署名した JWT。
 *    audience はプロジェクト番号
 *
 * 両方式を順に検証し、どちらも通らなければ 401(デコードした請求内容を
 * ログに残して原因を特定できるようにする)。
 * https://developers.google.com/workspace/chat/authenticate-verify-requests-google-chat
 */
const CHAT_SYSTEM_ISSUER = 'chat@system.gserviceaccount.com';
const CHAT_CERT_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_SYSTEM_ISSUER}`;

const oauthClient = new OAuth2Client();

interface CachedCerts {
  certs: Record<string, string>;
  fetchedAt: number;
}
let certCache: CachedCerts | undefined;
const CERT_TTL_MS = 60 * 60 * 1000;

async function getChatSystemCerts(): Promise<Record<string, string>> {
  if (certCache !== undefined && Date.now() - certCache.fetchedAt < CERT_TTL_MS) {
    return certCache.certs;
  }
  const res = await fetch(CHAT_CERT_URL);
  if (!res.ok) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Chat 検証用証明書の取得に失敗しました', {
      status: 401,
      details: { status: res.status },
    });
  }
  const certs = (await res.json()) as Record<string, string>;
  certCache = { certs, fetchedAt: Date.now() };
  return certs;
}

/** Google Chat の呼び出し元として許可するサービスアカウント。 */
export function allowedCallerEmails(projectNumber: string): string[] {
  return [
    CHAT_SYSTEM_ISSUER,
    `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
  ];
}

/** 診断用: 検証せずに JWT のクレーム(iss/aud/email のみ)を取り出す。 */
function decodeClaimsForLog(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return {};
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return { iss: claims['iss'], aud: claims['aud'], email: claims['email'] };
  } catch {
    return {};
  }
}

/** Bearer トークンを検証する(新旧両方式)。 */
export async function verifyChatRequest(req: http.IncomingMessage): Promise<void> {
  const projectNumber = requireEnv('GCP_PROJECT_NUMBER');
  const authorization = req.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_MISSING, 'Authorization ヘッダーがありません', {
      status: 401,
    });
  }
  const token = authorization.slice('Bearer '.length);

  // 新方式: Google 発行の ID トークン。audience は本サービスの URL(Host から導出)
  // またはプロジェクト番号。呼び出し元 SA の email を必ず照合する
  const host = req.headers.host;
  const audiences: string[] = [projectNumber];
  if (host !== undefined && host !== '') {
    audiences.push(`https://${host}`, `https://${host}/`);
  }
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: audiences });
    const payload = ticket.getPayload();
    const email = payload?.email;
    if (
      email !== undefined &&
      payload?.email_verified === true &&
      allowedCallerEmails(projectNumber).includes(email)
    ) {
      return;
    }
    throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'Chat の呼び出し元として許可されていません', {
      status: 403,
      details: { email: email ?? '(なし)' },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === ERROR_CODES.AUTH_FORBIDDEN) throw err;
    // 旧方式へフォールバック
  }

  try {
    const certs = await getChatSystemCerts();
    await oauthClient.verifySignedJwtWithCertsAsync(token, certs, projectNumber, [
      CHAT_SYSTEM_ISSUER,
    ]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    // どちらの方式でも検証できなかった。原因特定のためクレーム概要をログに残す
    logger.warn('Chat トークンの検証に失敗しました', {
      claims: decodeClaimsForLog(token),
      expectedAudiences: audiences,
    });
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Chat リクエストの検証に失敗しました', {
      status: 401,
      cause: err,
    });
  }
}

export interface OpsUser {
  user_id: string;
  display_name: string;
  email: string;
  role: 'admin' | 'member';
  chat_space_id: string | null;
  active: boolean;
}

/** イベントの送信者メールアドレスを ops.users に解決する。未登録なら undefined。 */
export async function resolveUser(pool: pg.Pool, email: string | undefined): Promise<OpsUser | undefined> {
  if (email === undefined || email === '') return undefined;
  const result = await query<OpsUser>(
    pool,
    `SELECT user_id, display_name, email, role, chat_space_id, active
     FROM ops.users WHERE email = $1 AND active`,
    [email],
  );
  return result.rows[0];
}
