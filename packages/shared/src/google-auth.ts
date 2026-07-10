import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
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
  /**
   * Drive 書込(ナレッジ管理 UI の投入・削除)。DWD ではなくランタイム SA 自身のトークンで使う。
   * SA が書込めるのは「編集者」で共有されたフォルダに限られるため、
   * 実効的な権限境界はスコープではなく Drive の共有 ACL(要件 v0.4 §2)。
   */
  DRIVE: 'https://www.googleapis.com/auth/drive',
  CALENDAR_READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
} as const;

// ── サービス間認証(OIDC ID トークン)────────────────────────────────────
// Cloud Run サービス間呼び出し(例: dashboard → batch の「今すぐ同期」)用。
// ランタイム SA 自身の ID トークンで、呼び出し先の Cloud Run IAM(roles/run.invoker)と
// アプリ層検証(batch の BATCH_INVOKER_SA 照合)の両方で検証される。

const idTokenClientCache = new Map<string, IdTokenClient>();

/** audience(呼び出し先サービスの URL)向けの OIDC ID トークンを取得する。 */
export async function getIdTokenFor(audience: string): Promise<string> {
  try {
    let client = idTokenClientCache.get(audience);
    if (client === undefined) {
      client = await getGoogleAuth([SCOPES.CLOUD_PLATFORM]).getIdTokenClient(audience);
      idTokenClientCache.set(audience, client);
    }
    return await client.idTokenProvider.fetchIdToken(audience);
  } catch (err) {
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      `OIDC ID トークンを取得できませんでした(audience: ${audience})`,
      { cause: err },
    );
  }
}

// ── ドメイン全体委任(Domain-Wide Delegation)────────────────────────────
// メンバー本人としてカレンダー等を読むためのトークン取得。SA キーは持たないため、
// IAM Credentials API の signJwt で SA 署名の JWT を作り、OAuth2 トークンと交換する。
// 前提(deployment-setup.md 参照):
//   1) Workspace 管理者がランタイム SA のクライアント ID に対象スコープを委任
//   2) ランタイム SA 自身への roles/iam.serviceAccountTokenCreator 付与

/**
 * ドメイン全体委任で要求を許可するスコープのホワイトリスト。
 * Workspace 管理者が委任したスコープ(deployment-setup.md Step 7-6)と常に一致させる。
 * 新しい委任スコープを使う機能を追加する場合は、Workspace 側の委任設定と同時に
 * このリストを更新すること(リスト外のスコープは AUTH_TOKEN_INVALID で拒否される)。
 */
const DELEGATED_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set([SCOPES.CALENDAR_READONLY]);

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
  // 委任スコープの限定: 委任トークンは本人として振る舞えるため、
  // 実装済み機能が必要とする最小スコープ以外の要求はコード側でも拒否する(多層防御)
  const disallowed = scopes.filter((scope) => !DELEGATED_SCOPE_ALLOWLIST.has(scope));
  if (disallowed.length > 0) {
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      `許可されていない委任スコープです: ${disallowed.join(', ')}(許可リストは google-auth.ts の DELEGATED_SCOPE_ALLOWLIST)`,
      { details: { disallowedScopes: disallowed } },
    );
  }
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
