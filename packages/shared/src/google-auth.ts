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
  CALENDAR_READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
} as const;

// ── ドメイン全体委任(Domain-Wide Delegation)────────────────────────────
// メンバー本人としてカレンダー等を読むためのトークン取得。SA キーは持たないため、
// IAM Credentials API の signJwt で SA 署名の JWT を作り、OAuth2 トークンと交換する。
// 前提(deployment-setup.md 参照):
//   1) Workspace 管理者がランタイム SA のクライアント ID に対象スコープを委任
//   2) ランタイム SA 自身への roles/iam.serviceAccountTokenCreator 付与

interface CachedToken {
  token: string;
  expiresAt: number;
}
const delegatedTokenCache = new Map<string, CachedToken>();
let cachedSaEmail: string | undefined;

async function serviceAccountEmail(): Promise<string> {
  if (cachedSaEmail !== undefined) return cachedSaEmail;
  const fromEnv = process.env['DELEGATION_SA_EMAIL'];
  if (fromEnv !== undefined && fromEnv !== '') {
    cachedSaEmail = fromEnv;
    return fromEnv;
  }
  const credentials = await getGoogleAuth([SCOPES.CLOUD_PLATFORM]).getCredentials();
  if (credentials.client_email === undefined) {
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      'ランタイム SA のメールアドレスを特定できません(DELEGATION_SA_EMAIL で明示してください)',
    );
  }
  cachedSaEmail = credentials.client_email;
  return cachedSaEmail;
}

/** subject(メンバーのメール)として振る舞う委任アクセストークンを取得する。 */
export async function getDelegatedAccessToken(
  subjectEmail: string,
  scopes: string[],
): Promise<string> {
  const cacheKey = `${subjectEmail}|${[...scopes].sort().join(' ')}`;
  const cached = delegatedTokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const saEmail = await serviceAccountEmail();
  const accessToken = await getAccessToken([SCOPES.CLOUD_PLATFORM]);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: saEmail,
    sub: subjectEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: scopes.join(' '),
    iat: now,
    exp: now + 3600,
  };

  const signRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signJwt`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
    },
  );
  if (!signRes.ok) {
    const body = await signRes.text().catch(() => '');
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      `委任 JWT の署名に失敗しました (HTTP ${signRes.status})。ランタイム SA への roles/iam.serviceAccountTokenCreator 付与を確認してください`,
      { details: { status: signRes.status, body: body.slice(0, 300) } },
    );
  }
  const { signedJwt } = (await signRes.json()) as { signedJwt: string };

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      `委任トークンの交換に失敗しました (HTTP ${tokenRes.status})。Workspace のドメイン全体委任設定を確認してください`,
      { details: { status: tokenRes.status, body: body.slice(0, 300) } },
    );
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string; expires_in?: number };
  delegatedTokenCache.set(cacheKey, {
    token: tokenJson.access_token,
    expiresAt: Date.now() + (tokenJson.expires_in ?? 3600) * 1000,
  });
  return tokenJson.access_token;
}
