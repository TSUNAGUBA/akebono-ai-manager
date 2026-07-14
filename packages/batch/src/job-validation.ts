import { AppError, ERROR_CODES, query } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * オペレーター起動ジョブ(escalation-action / dialogue-feedback — v0.12 §3・§6)共通の
 * パラメータ検証ヘルパー。想定エラーには JOB_PARAMS_INVALID(400)を付与し、
 * ダッシュボード側でオペレーターに原因を提示できるようにする。
 */

/** ジョブパラメータ不正の AppError(400)を作る。 */
export function invalidJobParams(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(ERROR_CODES.JOB_PARAMS_INVALID, message, { status: 400, details });
}

/** 必須の文字列パラメータを検証して返す(欠落・空は JOB_PARAMS_INVALID)。 */
export function requireParam(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw invalidJobParams(`${name} は必須です`);
  }
  return value;
}

/** 上限文字数を検証して返す(本文系パラメータ用)。 */
export function requireTextParam(value: string | undefined, name: string, maxLength: number): string {
  const text = requireParam(value, name);
  if (text.length > maxLength) {
    throw invalidJobParams(`${name} は ${maxLength} 文字以内で指定してください`, {
      length: text.length,
    });
  }
  return text;
}

/**
 * 操作者が active な admin であることを検証する(不一致は JOB_PARAMS_INVALID・400)。
 * ダッシュボード側でも管理者認可を行うが、ジョブ API は OIDC さえ通れば呼べるため、
 * 記録される操作者(resolved_by / created_by)の正当性をジョブ側でも検証する(多層防御)。
 */
export async function verifyAdminOperator(pool: pg.Pool, operatorUserId: string): Promise<void> {
  const found = await query(
    pool,
    `SELECT 1 FROM ops.users WHERE user_id = $1 AND active AND role = 'admin'`,
    [operatorUserId],
  );
  if (found.rows.length === 0) {
    throw invalidJobParams('operatorUserId が active な管理者ではありません', { operatorUserId });
  }
}
