import { AppError, ERROR_CODES } from './errors.js';
import { logger } from './logger.js';

/** 必須の環境変数を読む。未設定なら AIM-1001。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new AppError(ERROR_CODES.CONFIG_MISSING, `環境変数 ${name} が設定されていません`, {
      details: { name },
    });
  }
  return value;
}

/** 任意の環境変数を読む。未設定ならデフォルト値。 */
export function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? defaultValue : value;
}

export function optionalIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError(ERROR_CODES.CONFIG_INVALID, `環境変数 ${name} は整数である必要があります`, {
      details: { name, value: raw },
    });
  }
  return parsed;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 'require'(既定。RDS への接続は SSL 必須)または 'disable'(ローカル開発のみ) */
  sslMode: 'require' | 'disable';
  /** RDS CA バンドルのパス(コンテナイメージに同梱) */
  sslCaPath: string | undefined;
  /** サーバーレスからの接続数暴発を防ぐため小さく保つ(要件 6.3) */
  poolMax: number;
}

export function loadDbConfig(): DbConfig {
  const sslMode = optionalEnv('DB_SSL', 'require');
  if (sslMode !== 'require' && sslMode !== 'disable') {
    throw new AppError(
      ERROR_CODES.CONFIG_INVALID,
      `環境変数 DB_SSL は require / disable のいずれかです`,
      { details: { value: sslMode } },
    );
  }
  return {
    host: requireEnv('DB_HOST'),
    port: optionalIntEnv('DB_PORT', 5432),
    database: optionalEnv('DB_NAME', 'ai_manager'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    sslMode,
    sslCaPath: process.env['DB_SSL_CA'],
    poolMax: optionalIntEnv('DB_POOL_MAX', 2),
  };
}

/**
 * マスタ管理(ダッシュボード管理者限定ページ)用の管理 DB 接続設定(要件 v0.3 §5.1)。
 * 専用ロール ai_manager_admin_rw で接続し、マスタ 4 表+ops.customers のみ書込可能な
 * 二重制御(アプリ層 role=admin 判定+DB ロール分離)の DB 側を担う。
 *
 * DB_ADMIN_USER / DB_ADMIN_PASSWORD が両方設定されている場合のみ有効。
 * 未設定なら undefined を返し、マスタ管理ページは案内表示に切り替わる
 * (グレースフルデグラデーション。既存の閲覧機能には影響しない)。
 * 接続先・SSL 等その他の設定は既存の DB 設定(loadDbConfig)を継承する。
 */
export function loadAdminDbConfig(): DbConfig | undefined {
  const user = process.env['DB_ADMIN_USER'];
  const password = process.env['DB_ADMIN_PASSWORD'];
  const hasUser = user !== undefined && user !== '';
  const hasPassword = password !== undefined && password !== '';
  if (!hasUser || !hasPassword) {
    if (hasUser !== hasPassword) {
      // 片方だけの設定は設定ミスの可能性が高いが、閲覧機能を止めないため警告に留める
      logger.warn(
        'DB_ADMIN_USER / DB_ADMIN_PASSWORD は片方のみ設定されています。マスタ管理は未構成として扱います',
        { errorCode: ERROR_CODES.ADMIN_DB_NOT_CONFIGURED },
      );
    }
    return undefined;
  }
  return {
    ...loadDbConfig(),
    user,
    password,
    // 管理操作は低頻度のため接続数は既定 2 に絞る(接続数暴発の防止は要件 6.3 と同旨)
    poolMax: optionalIntEnv('DB_ADMIN_POOL_MAX', 2),
  };
}

export interface VertexConfig {
  projectId: string;
  /**
   * 生成系モデル(generateContent)の呼び出し先ロケーション。既定は 'global'。
   * gemini-2.5-flash-lite 等は asia-northeast1 では未提供(グローバルでは提供)のため、
   * 未提供のリージョナルエンドポイントに投げると HTTP 404(AIM-4001)になる。
   * データレジデンシー要件がある場合は VERTEX_LOCATION でリージョンを指定し、
   * そのリージョンで提供されているモデルを MODEL_* で選ぶこと。
   */
  location: string;
  /**
   * embedding(predict)の呼び出し先ロケーション。既定は GCP_REGION。
   * gemini-embedding-001 は asia-northeast1 を含むリージョナル提供がある。
   */
  embeddingLocation: string;
  models: {
    /** 定型(挨拶・進捗確認・要約・分類) */
    flashLite: string;
    /** 知識回答(RAG 参照のドメイン解説)・日報生成 */
    flash: string;
    /** 思考支援(仮説壁打ち・例え話)・エスカレーション判定 */
    pro: string;
  };
  embedding: {
    model: string;
    /** rag スキーマの vector(768) と一致させること */
    dimensions: number;
  };
}

/** URL・識別子に埋め込む値は前後空白を除去し、空白のみなら既定値扱いにする(誤設定への事故耐性)。 */
function trimmedEnv(name: string, defaultValue: string): string {
  const value = optionalEnv(name, defaultValue).trim();
  return value === '' ? defaultValue : value;
}

export function loadVertexConfig(): VertexConfig {
  // GCP_REGION はデプロイ先リージョン。embedding はリージョナル提供があるため既定でこれに追従する
  const region = trimmedEnv('GCP_REGION', 'asia-northeast1');
  return {
    projectId: requireEnv('GCP_PROJECT_ID'),
    location: trimmedEnv('VERTEX_LOCATION', 'global'),
    embeddingLocation: trimmedEnv('VERTEX_EMBEDDING_LOCATION', region),
    models: {
      flashLite: trimmedEnv('MODEL_FLASH_LITE', 'gemini-2.5-flash-lite'),
      flash: trimmedEnv('MODEL_FLASH', 'gemini-2.5-flash'),
      pro: trimmedEnv('MODEL_PRO', 'gemini-2.5-pro'),
    },
    embedding: {
      model: trimmedEnv('EMBEDDING_MODEL', 'gemini-embedding-001'),
      dimensions: optionalIntEnv('EMBEDDING_DIMENSIONS', 768),
    },
  };
}
