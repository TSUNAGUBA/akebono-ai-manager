import { AppError, ERROR_CODES } from './errors.js';

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

export interface VertexConfig {
  projectId: string;
  /**
   * 生成系モデル(generateContent)の呼び出し先ロケーション。既定は 'global'。
   * gemini-2.5-flash-lite 等はグローバルエンドポイント限定提供のため、
   * リージョナルエンドポイントに投げると HTTP 404(AIM-4001)になる。
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

export function loadVertexConfig(): VertexConfig {
  // GCP_REGION はデプロイ先リージョン。embedding はリージョナル提供があるため既定でこれに追従する
  const region = optionalEnv('GCP_REGION', 'asia-northeast1');
  return {
    projectId: requireEnv('GCP_PROJECT_ID'),
    location: optionalEnv('VERTEX_LOCATION', 'global'),
    embeddingLocation: optionalEnv('VERTEX_EMBEDDING_LOCATION', region),
    models: {
      flashLite: optionalEnv('MODEL_FLASH_LITE', 'gemini-2.5-flash-lite'),
      flash: optionalEnv('MODEL_FLASH', 'gemini-2.5-flash'),
      pro: optionalEnv('MODEL_PRO', 'gemini-2.5-pro'),
    },
    embedding: {
      model: optionalEnv('EMBEDDING_MODEL', 'gemini-embedding-001'),
      dimensions: optionalIntEnv('EMBEDDING_DIMENSIONS', 768),
    },
  };
}
