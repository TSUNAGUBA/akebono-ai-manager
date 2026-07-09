import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from '@ai-manager/shared';

/**
 * マイグレーションファイルの命名・順序の純粋ロジック(テスト対象)。
 * - versioned: migrations/NNNN_name.sql … 一度だけ適用。適用後の変更は禁止
 * - repeatable: etl/NN_name.sql        … 毎回適用・冪等(ビュー・関数・GRANT・pg_cron 登録)
 */
const VERSIONED_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const REPEATABLE_PATTERN = /^\d{2}_[a-z0-9_]+\.sql$/;

export function sortVersionedFiles(names: string[]): string[] {
  const invalid = names.filter((n) => !VERSIONED_PATTERN.test(n));
  if (invalid.length > 0) {
    throw new AppError(
      ERROR_CODES.DB_MIGRATION_FAILED,
      `マイグレーションファイル名が規約(NNNN_name.sql)に合いません: ${invalid.join(', ')}`,
    );
  }
  const sorted = [...names].sort();
  const versions = sorted.map((n) => n.slice(0, 4));
  const dup = versions.find((v, i) => versions.indexOf(v) !== i);
  if (dup !== undefined) {
    throw new AppError(
      ERROR_CODES.DB_MIGRATION_FAILED,
      `マイグレーションのバージョン番号が重複しています: ${dup}`,
    );
  }
  return sorted;
}

export function sortRepeatableFiles(names: string[]): string[] {
  const invalid = names.filter((n) => !REPEATABLE_PATTERN.test(n));
  if (invalid.length > 0) {
    throw new AppError(
      ERROR_CODES.DB_MIGRATION_FAILED,
      `repeatable マイグレーションのファイル名が規約(NN_name.sql)に合いません: ${invalid.join(', ')}`,
    );
  }
  return [...names].sort();
}

export function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
