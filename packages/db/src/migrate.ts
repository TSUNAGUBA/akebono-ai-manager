import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  createPool,
  ERROR_CODES,
  logger,
  withClient,
} from '@ai-manager/shared';
import { checksum, sortRepeatableFiles, sortVersionedFiles } from './files.js';

/**
 * マイグレーションランナー。
 * - versioned(migrations/)は一度だけ、ファイル順に適用。各ファイルは1トランザクション
 * - repeatable(etl/)は毎回適用する(ビュー・ETL関数・GRANT・pg_cron 登録。すべて冪等)。
 *   「後から DB ロールを作成した」「後から pg_cron を有効化した」場合も、
 *   db-migrate ジョブの再実行だけで反映される(手動回復パスを不要にする)
 * - advisory lock で同時実行を防止(再実行安全)
 * - 適用済み versioned ファイルの変更はエラー(AIM-2004)として検出
 */
const MIGRATE_LOCK_KEY = 762_001; // ai-manager migrate 用の固定キー

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSqlFiles(
  dir: string,
  sorter: (names: string[]) => string[],
): Promise<Array<{ name: string; sql: string; hash: string }>> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
  const sorted = sorter(names);
  return Promise.all(
    sorted.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, hash: checksum(sql) };
    }),
  );
}

export async function runMigrations(): Promise<void> {
  const pool = createPool();
  try {
    await withClient(pool, async (client) => {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.schema_migrations (
            version    TEXT PRIMARY KEY,
            checksum   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.repeatable_migrations (
            name       TEXT PRIMARY KEY,
            checksum   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`);

        // ── versioned ──
        const applied = new Map<string, string>();
        const appliedRows = await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM public.schema_migrations',
        );
        for (const row of appliedRows.rows) applied.set(row.version, row.checksum);

        const versioned = await loadSqlFiles(path.join(packageRoot, 'migrations'), sortVersionedFiles);
        for (const file of versioned) {
          const appliedChecksum = applied.get(file.name);
          if (appliedChecksum !== undefined) {
            if (appliedChecksum !== file.hash) {
              throw new AppError(
                ERROR_CODES.DB_MIGRATION_CHECKSUM_MISMATCH,
                `適用済みマイグレーション ${file.name} が変更されています。適用済みファイルは変更せず、新しいマイグレーションを追加してください`,
              );
            }
            continue;
          }
          logger.info(`versioned マイグレーションを適用: ${file.name}`);
          try {
            await client.query('BEGIN');
            await client.query(file.sql);
            await client.query(
              'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)',
              [file.name, file.hash],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw new AppError(
              ERROR_CODES.DB_MIGRATION_FAILED,
              `マイグレーション ${file.name} の適用に失敗しました`,
              { cause: err },
            );
          }
        }

        // ── repeatable(毎回適用・冪等)──
        const repeatable = await loadSqlFiles(path.join(packageRoot, 'etl'), sortRepeatableFiles);
        for (const file of repeatable) {
          logger.info(`repeatable マイグレーションを適用: ${file.name}`);
          try {
            await client.query('BEGIN');
            await client.query(file.sql);
            await client.query(
              `INSERT INTO public.repeatable_migrations (name, checksum) VALUES ($1, $2)
               ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
              [file.name, file.hash],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw new AppError(
              ERROR_CODES.DB_MIGRATION_FAILED,
              `repeatable マイグレーション ${file.name} の適用に失敗しました`,
              { cause: err },
            );
          }
        }

        logger.info('マイグレーション完了', {
          versioned: versioned.length,
          repeatable: repeatable.length,
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]);
      }
    });
  } finally {
    await pool.end();
  }
}

// エントリーポイント(Cloud Run Job から実行)
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(() => {
      logger.info('migrate: success');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error('migrate: failed', err);
      process.exit(1);
    });
}
