import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadDbConfig, type DbConfig } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';
import { logger } from './logger.js';

/**
 * PostgreSQL 接続プール。
 * サーバーレス環境からの接続数暴発を防ぐためプールは小さく保つ(要件 6.3)。
 */
export function createPool(config: DbConfig = loadDbConfig()): pg.Pool {
  let ssl: pg.PoolConfig['ssl'];
  if (config.sslMode === 'disable') {
    ssl = false;
  } else if (config.sslCaPath !== undefined && config.sslCaPath !== '') {
    ssl = { ca: readFileSync(config.sslCaPath, 'utf8'), rejectUnauthorized: true };
  } else {
    // CA 未指定時はシステム CA で検証する(RDS はイメージ同梱の CA を DB_SSL_CA で指定する運用)
    ssl = { rejectUnauthorized: true };
  }

  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl,
  });

  pool.on('error', (err) => {
    // アイドル接続のエラーはプロセスを落とさずログに残す
    logger.error('DB プールでエラーが発生しました', err, { errorCode: ERROR_CODES.DB_CONNECTION_FAILED });
  });

  return pool;
}

/** クエリ実行の薄いラッパー。失敗時に AIM-2002 を付与する。 */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool | pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  try {
    return await pool.query<R>(text, params);
  } catch (err) {
    throw new AppError(ERROR_CODES.DB_QUERY_FAILED, 'DB クエリの実行に失敗しました', {
      cause: err,
      details: { query: text.slice(0, 120) },
    });
  }
}

/** 1接続を借りて処理を実行する(トランザクション用)。 */
export async function withClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect().catch((err: unknown) => {
    throw new AppError(ERROR_CODES.DB_CONNECTION_FAILED, 'DB への接続に失敗しました', { cause: err });
  });
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * 1接続を借りてトランザクション内で処理を実行する。
 * fn が例外を投げた場合は ROLLBACK して元の例外を再送出する。
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

/** pgvector に渡すベクトルリテラル表現('[0.1,0.2,...]')を作る。 */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}
