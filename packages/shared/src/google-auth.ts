import { GoogleAuth } from 'google-auth-library';
import { AppError, ERROR_CODES } from './errors.js';

/**
 * Application Default Credentials(Cloud Run のランタイム SA)によるアクセストークン取得。
 * スコープの組み合わせごとに GoogleAuth インスタンスをキャッシュする。
 */
const authCache = new Map<string, GoogleAuth>();

export function getGoogleAuth(scopes: string[]): GoogleAuth {
  const key = [...scopes].sort().join(' ');
  let auth = authCache.get(key);
  if (auth === undefined) {
    auth = new GoogleAuth({ scopes });
    authCache.set(key, auth);
  }
  return auth;
}

export async function getAccessToken(scopes: string[]): Promise<string> {
  const auth = getGoogleAuth(scopes);
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (token.token === null || token.token === undefined) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Google アクセストークンを取得できませんでした');
  }
  return token.token;
}

export const SCOPES = {
  CLOUD_PLATFORM: 'https://www.googleapis.com/auth/cloud-platform',
  CHAT_BOT: 'https://www.googleapis.com/auth/chat.bot',
  DRIVE_READONLY: 'https://www.googleapis.com/auth/drive.readonly',
} as const;
