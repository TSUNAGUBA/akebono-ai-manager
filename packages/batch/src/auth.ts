import type http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { AppError, ERROR_CODES, optionalEnv } from '@ai-manager/shared';

/**
 * Cloud Scheduler からの OIDC トークン検証。
 * バッチサービスは Cloud Run の IAM(--no-allow-unauthenticated)で保護されるが、
 * 設定ミスで公開された場合の防御として、アプリ層でも検証する(多層防御)。
 *
 * - トークンの audience は Cloud Run のサービス URL(Host ヘッダーから導出)
 * - 発行者は accounts.google.com
 * - email クレームが BATCH_INVOKER_SA(Scheduler が用いる SA)と一致すること
 */
const oauthClient = new OAuth2Client();

export async function verifySchedulerRequest(req: http.IncomingMessage): Promise<void> {
  const authorization = req.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_MISSING, 'Authorization ヘッダーがありません', {
      status: 401,
    });
  }
  const token = authorization.slice('Bearer '.length);

  const host = req.headers.host;
  const audience = optionalEnv('BATCH_OIDC_AUDIENCE', host === undefined ? '' : `https://${host}`);
  if (audience === '') {
    throw new AppError(ERROR_CODES.CONFIG_MISSING, 'OIDC audience を決定できません', { status: 401 });
  }

  let email: string | undefined;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
    email = ticket.getPayload()?.email;
  } catch (err) {
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'OIDC トークンの検証に失敗しました', {
      status: 401,
      cause: err,
    });
  }

  const expectedInvoker = optionalEnv('BATCH_INVOKER_SA', '');
  if (expectedInvoker !== '' && email !== expectedInvoker) {
    throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, '許可されていない呼び出し元です', {
      status: 403,
      details: { email: email ?? '(なし)' },
    });
  }
}
