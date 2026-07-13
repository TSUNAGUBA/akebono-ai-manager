import { AppError, ERROR_CODES, isAppError, logger } from '@ai-manager/shared';
import type { Viewer } from '../render/layout.js';

/**
 * マスタ管理フォームの入力検証と監査ログ(要件 v0.3 §5.1)。
 * 識別子(industry_id / customer_id / relation_type)の検証は二段構え:
 *   - 新規作成時の ID: URL・Drive フォルダ規約に使われるため ^[a-z0-9_-]+$ に制限する(requireId)
 *   - 既存レコードを参照する ID: 実在性は FK 制約・WHERE 句が担保するため、
 *     非空+長さ上限のみ検証する(requireRef)。パターン外の既存 ID も操作可能に保つ
 */

export const ID_PATTERN = /^[a-z0-9_-]+$/;
export const ID_MAX_LENGTH = 64;
const TEXT_MAX_LENGTH = 500;

/** PostgreSQL SQLSTATE: 一意制約違反 */
export const PG_UNIQUE_VIOLATION = '23505';
/** PostgreSQL SQLSTATE: 外部キー違反 */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** 入力値エラー(AIM-6004 / 400)。ページ内のエラーバナーとして表示される。 */
export function invalidInput(message: string): AppError {
  return new AppError(ERROR_CODES.ADMIN_INPUT_INVALID, message, { status: 400 });
}

/** 既存データとの競合(AIM-6005 / 409)。 */
export function writeConflict(message: string): AppError {
  return new AppError(ERROR_CODES.ADMIN_WRITE_CONFLICT, message, { status: 409 });
}

/**
 * query() が包んだ AppError の cause から PostgreSQL の SQLSTATE を判定する
 * (一意制約違反 = PG_UNIQUE_VIOLATION、外部キー違反 = PG_FOREIGN_KEY_VIOLATION 等)。
 */
export function hasPgCode(err: unknown, code: string): boolean {
  if (!isAppError(err)) return false;
  const cause = err.cause as { code?: unknown } | undefined;
  return typeof cause === 'object' && cause !== null && cause.code === code;
}

/**
 * 既存レコードを参照する識別子(セレクトボックス・hidden input 由来)。
 * 実在性は FK 制約・WHERE 句が担保するため、非空+長さ上限のみ検証する。
 */
export function requireRef(form: URLSearchParams, field: string, label: string): string {
  const value = (form.get(field) ?? '').trim();
  if (value === '') throw invalidInput(`${label}を入力してください`);
  if (value.length > ID_MAX_LENGTH) {
    throw invalidInput(`${label}は ${ID_MAX_LENGTH} 文字以内で入力してください`);
  }
  return value;
}

/**
 * 数値 ID(BIGINT 列の識別子)。requireRef は長さしか検証しないため、
 * 非数値・BIGINT 範囲超(19 桁以上)が PG の 22P02 / 22003(→ 500)に落ちる前に
 * 400 で弾く(プロジェクトのマイルストーン・タスク、エスカレーション、対話 ID 等で共用)。
 */
export function requireNumericId(form: URLSearchParams, field: string, label: string): string {
  const value = requireRef(form, field, label);
  if (!/^\d{1,18}$/.test(value)) {
    throw invalidInput(`${label}の指定が不正です。ページを再読み込みしてやり直してください`);
  }
  return value;
}

/** YYYY-MM-DD 形式かつカレンダー上実在する日付か(2026-02-31 等を 500 にせず 400 で弾く)。 */
export function isRealDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 新規作成時の識別子(^[a-z0-9_-]+$)。URL・フォルダ規約に使われるため厳格に検証する。 */
export function requireId(form: URLSearchParams, field: string, label: string): string {
  const value = requireRef(form, field, label);
  if (!ID_PATTERN.test(value)) {
    throw invalidInput(
      `${label}は半角の小文字英数字・ハイフン・アンダースコアのみ使用できます(例: apparel-retail_01)`,
    );
  }
  return value;
}

/** 必須のテキスト(表示名等)。 */
export function requireText(
  form: URLSearchParams,
  field: string,
  label: string,
  maxLength = TEXT_MAX_LENGTH,
): string {
  const value = (form.get(field) ?? '').trim();
  if (value === '') throw invalidInput(`${label}を入力してください`);
  if (value.length > maxLength) {
    throw invalidInput(`${label}は ${maxLength} 文字以内で入力してください`);
  }
  return value;
}

/** 任意のテキスト。空なら null(DB では NULL として保存)。 */
export function optionalText(
  form: URLSearchParams,
  field: string,
  label: string,
  maxLength = TEXT_MAX_LENGTH,
): string | null {
  const value = (form.get(field) ?? '').trim();
  if (value === '') return null;
  if (value.length > maxLength) {
    throw invalidInput(`${label}は ${maxLength} 文字以内で入力してください`);
  }
  return value;
}

/** 任意の整数。空なら null。数値でなければ AIM-6004。 */
export function optionalInt(form: URLSearchParams, field: string, label: string): number | null {
  const value = (form.get(field) ?? '').trim();
  if (value === '') return null;
  if (!/^-?\d+$/.test(value)) throw invalidInput(`${label}は整数で入力してください`);
  return Number.parseInt(value, 10);
}

/** チェックボックス(存在すれば on)。 */
export function isChecked(form: URLSearchParams, field: string): boolean {
  return form.get(field) !== null;
}

/**
 * 監査ログ(要件 v0.3 §5.1: 誰が・いつ・何を)。
 * 構造化ログとして Cloud Logging に残る(いつ=ログの time フィールド)。
 */
export function auditLog(
  viewer: Viewer,
  action: string,
  target: Record<string, unknown>,
  values: Record<string, unknown> = {},
): void {
  logger.info('マスタ管理の変更操作', {
    audit: { operator: viewer.email, action, target, values },
  });
}
