/**
 * エラーコードの一元管理。
 *
 * 想定エラーには必ずここで定義したコードを付与する(CLAUDE.md / Phase 7 ゲート条件)。
 * コード体系:
 *   AIM-1xxx: 設定・起動
 *   AIM-2xxx: データベース
 *   AIM-3xxx: 認証・Chat ゲートウェイ
 *   AIM-4xxx: LLM・Embedding
 *   AIM-5xxx: バッチジョブ・外部連携
 *   AIM-6xxx: ダッシュボード
 *
 * 逆引きリファレンス: docs/operations/error-codes.md(本ファイルと同期を保つこと)
 */
export const ERROR_CODES = {
  /** 必須の環境変数が未設定 */
  CONFIG_MISSING: 'AIM-1001',
  /** 環境変数の値が不正 */
  CONFIG_INVALID: 'AIM-1002',

  /** DB 接続に失敗 */
  DB_CONNECTION_FAILED: 'AIM-2001',
  /** DB クエリの実行に失敗 */
  DB_QUERY_FAILED: 'AIM-2002',
  /** マイグレーションの適用に失敗 */
  DB_MIGRATION_FAILED: 'AIM-2003',
  /** 適用済みマイグレーションファイルが変更されている */
  DB_MIGRATION_CHECKSUM_MISMATCH: 'AIM-2004',

  /** Authorization ヘッダーが無い */
  AUTH_TOKEN_MISSING: 'AIM-3001',
  /** トークンの検証に失敗(署名・発行者・audience) */
  AUTH_TOKEN_INVALID: 'AIM-3002',
  /** ops.users に存在しないユーザー */
  AUTH_USER_UNKNOWN: 'AIM-3003',
  /** ロール不足(管理者限定リソース等) */
  AUTH_FORBIDDEN: 'AIM-3004',
  /** 対応していない Chat イベント種別 */
  CHAT_EVENT_UNSUPPORTED: 'AIM-3101',
  /** Google Chat API へのメッセージ送信に失敗 */
  CHAT_SEND_FAILED: 'AIM-3102',
  /** リクエストボディが JSON として不正 */
  REQUEST_BODY_INVALID: 'AIM-3103',

  /** LLM API 呼び出しに失敗 */
  LLM_REQUEST_FAILED: 'AIM-4001',
  /** LLM 応答が期待した構造でない */
  LLM_RESPONSE_INVALID: 'AIM-4002',
  /** Embedding API 呼び出しに失敗 */
  EMBEDDING_FAILED: 'AIM-4003',

  /** 存在しないジョブ名 */
  JOB_UNKNOWN: 'AIM-5001',
  /** ジョブ実行が致命的に失敗 */
  JOB_FAILED: 'AIM-5002',
  /** Google Drive からのナレッジ同期に失敗 */
  DRIVE_SYNC_FAILED: 'AIM-5003',
  /** レポート生成に失敗 */
  REPORT_GENERATION_FAILED: 'AIM-5004',

  /** ダッシュボードのクエリに失敗 */
  DASHBOARD_QUERY_FAILED: 'AIM-6001',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppErrorOptions {
  /** HTTP レスポンスに使うステータスコード(既定 500) */
  status?: number;
  /** 元例外 */
  cause?: unknown;
  /** ログ・レスポンスに含める補足情報(秘匿情報を入れないこと) */
  details?: Record<string, unknown>;
}

/** コード付きの想定エラー。ハンドラ層で HTTP ステータスへ変換される。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
