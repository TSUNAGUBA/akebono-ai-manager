import type http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import {
  AppError,
  ERROR_CODES,
  query,
  requireEnv,
} from '@ai-manager/shared';
import type pg from 'pg';

/**
 * Google Chat からのリクエスト検証。
 * Chat はイベント送信時に chat@system.gserviceaccount.com 発行の JWT を
 * Authorization: Bearer として付与する。audience は GCP プロジェクト番号。
 * https://developers.google.com/workspace/chat/authenticate-verify-requests-google-chat
 */
const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const CHAT_CERT_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;

const oauthClient = new OAuth2Client();

interface CachedCerts {
  certs: Record<string, string>;
  fetchedAt: number;
}
let certCache: CachedCerts | undefined;
const CERT_TTL_MS = 60 * 60 * 1000;

async function getChatCerts(): Promise<Record<string, string>> {
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

/** Bearer トークンを検証する。audience は GCP_PROJECT_NUMBER。 */
export async function verifyChatRequest(req: http.IncomingMessage): Promise<void> {
  const projectNumber = requireEnv('GCP_PROJECT_NUMBER');
  const authorization = req.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_MISSING, 'Authorization ヘッダーがありません', {
      status: 401,
    });
  }
  const token = authorization.slice('Bearer '.length);
  try {
    const certs = await getChatCerts();
    await oauthClient.verifySignedJwtWithCertsAsync(token, certs, projectNumber, [CHAT_ISSUER]);
  } catch (err) {
    if (err instanceof AppError) throw err;
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
