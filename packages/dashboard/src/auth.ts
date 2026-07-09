import type http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import {
  AppError,
  ERROR_CODES,
  optionalEnv,
  query,
  requireEnv,
} from '@ai-manager/shared';
import type pg from 'pg';
import type { Viewer } from './render/layout.js';

/**
 * ダッシュボードの認証(要件 11: Google Workspace アカウントに一本化)。
 *
 * AUTH_MODE:
 *   - 'iap'(既定): Cloud IAP の署名付き JWT(x-goog-iap-jwt-assertion)を検証する。
 *     IAP_AUDIENCE の設定が必須。
 *   - 'header': X-Goog-Authenticated-User-Email ヘッダーを信頼する。
 *     IAP 等の信頼できるプロキシの背後でのみ使用可(前段なしでの使用は禁止)。
 *   - 'dev': DEV_USER_EMAIL を利用者とみなす。ローカル開発専用。
 */
const oauthClient = new OAuth2Client();

async function resolveEmail(req: http.IncomingMessage): Promise<string> {
  const mode = optionalEnv('AUTH_MODE', 'iap');

  if (mode === 'dev') {
    return requireEnv('DEV_USER_EMAIL');
  }

  if (mode === 'header') {
    const header = req.headers['x-goog-authenticated-user-email'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined || value === '') {
      throw new AppError(ERROR_CODES.AUTH_TOKEN_MISSING, '認証ヘッダーがありません', { status: 401 });
    }
    // 形式: accounts.google.com:user@example.com
    return value.includes(':') ? (value.split(':').pop() ?? '') : value;
  }

  // 既定: IAP JWT の厳格検証
  const audience = requireEnv('IAP_AUDIENCE');
  const assertion = req.headers['x-goog-iap-jwt-assertion'];
  const jwt = Array.isArray(assertion) ? assertion[0] : assertion;
  if (jwt === undefined || jwt === '') {
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_MISSING,
      'IAP の認証情報がありません。IAP 経由でアクセスしてください',
      { status: 401 },
    );
  }
  try {
    const keys = await oauthClient.getIapPublicKeys();
    const ticket = await oauthClient.verifySignedJwtWithCertsAsync(jwt, keys.pubkeys, audience, [
      'https://cloud.google.com/iap',
    ]);
    const email = ticket.getPayload()?.email;
    if (email === undefined || email === '') {
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'IAP トークンに email がありません', {
        status: 401,
      });
    }
    return email;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'IAP トークンの検証に失敗しました', {
      status: 401,
      cause: err,
    });
  }
}

/** リクエストから利用者を認証し、ops.users のロールを解決する。 */
export async function authenticateViewer(req: http.IncomingMessage, pool: pg.Pool): Promise<Viewer> {
  const email = await resolveEmail(req);
  const result = await query<{ user_id: string; display_name: string; email: string; role: 'admin' | 'member' }>(
    pool,
    `SELECT user_id, display_name, email, role FROM ops.users WHERE email = $1 AND active`,
    [email],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AppError(
      ERROR_CODES.AUTH_USER_UNKNOWN,
      'このアカウントは AI マネージャーに登録されていません。管理者に登録を依頼してください',
      { status: 403, details: { email } },
    );
  }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
  };
}

/** 管理者限定ページのガード(要件 M5: 管理者限定ビュー)。 */
export function requireAdmin(viewer: Viewer): void {
  if (viewer.role !== 'admin') {
    throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'このページは管理者のみ閲覧できます', {
      status: 403,
    });
  }
}
