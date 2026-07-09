import { AppError, ERROR_CODES, isAppError, logger } from '@ai-manager/shared';
import type { Viewer } from '../render/layout.js';

/**
 * マスタ管理フォームの入力検証と監査ログ(要件 v0.3 §5.1)。
 * 識別子(industry_id / customer_id / relation_type)は URL・Drive フォルダ規約に
 * 使われるため ^[a-z0-9_-]+$ に制限する。
 */

export const ID_PATTERN = /^[a-z0-9_-]+$/;
const ID_MAX_LENGTH = 64;
const TEXT_MAX_LENGTH = 500;

/** 入力値エラー(AIM-6004 / 400)。ページ内のエラーバナーとして表示される。 */
export function invalidInput(message: string): AppError {
  return new AppError(ERROR_CODES.ADMIN_INPUT_INVALID, message, { status: 400 });
}

/** 既存データとの競合(AIM-6005 / 409)。 */
export function writeConflict(message: string): AppError {
  return new AppError(ERROR_CODES.ADMIN_WRITE_CONFLICT, message, { status: 409 });
}

/** query() が包んだ AppError の cause から PostgreSQL の一意制約違反(23505)を判定する。 */
export function isUniqueViolation(err: unknown): boolean {
  if (!isAppError(err)) return false;
  const cause = err.cause as { code?: unknown } | undefined;
  return typeof cause === 'object' && cause !== null && cause.code === '23505';
}

/** 同 cause から外部キー違反(23503)を判定する(存在しないマスタ参照等)。 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!isAppError(err)) return false;
  const cause = err.cause as { code?: unknown } | undefined;
  return typeof cause === 'object' && cause !== null && cause.code === '23503';
}

/** 必須の識別子(^[a-z0-9_-]+$)。URL・フォルダ規約に使われるため厳格に検証する。 */
export function requireId(form: URLSearchParams, field: string, label: string): string {
  const value = (form.get(field) ?? '').trim();
  if (value === '') throw invalidInput(`${label}を入力してください`);
  if (value.length > ID_MAX_LENGTH) {
    throw invalidInput(`${label}は ${ID_MAX_LENGTH} 文字以内で入力してください`);
  }
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
