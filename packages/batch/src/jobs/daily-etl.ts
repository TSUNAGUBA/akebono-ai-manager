import { AppError, ERROR_CODES, jstDateString, jstDateStringDaysAgo, logger, query } from '@ai-manager/shared';
import type pg from 'pg';
import type { JobSummary } from './morning-checkin.js';

/**
 * ジョブパラメータ(v0.12 §6)。
 * targetDate 省略時は当日 JST。手動実行の目的は「当日の途中経過を今すぐ集計に反映する」
 * ため、既定を前日ではなく当日とする。翌日の pg_cron 定時実行(前日分)が同じ日付を
 * 洗い替えるため、先回りして実行しても集計が巻き戻る副作用はない(原則2)。
 */
export interface DailyEtlParams {
  targetDate?: string;
}

/** YYYY-MM-DD 形式(dwh.run_daily_etl の p_target_date に渡す前の形式検証)。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 手動実行で許可する対象日の遡り上限(日数)。
 * fact_workload は「その日の状態」の日次スナップショットで、過去分を遡って再計算できない。
 * 定時 ETL の洗い替えが及ぶルックバック範囲(7日)を超えた過去日を手動実行すると、
 * 確定済みの履歴スナップショットを「今日の状態」で上書きしてしまう(原則2: 記録系データの保護)。
 * 未来日は集計対象が存在しないため同じく拒否する。
 */
const TARGET_DATE_MAX_DAYS_AGO = 7;

/** カレンダー上実在する日付か(2026-02-31 等を DB エラーにせず 400 で弾く)。 */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 集計 ETL の手動実行(v0.12 §6)。ダッシュボードから OIDC 経由で起動され、
 * dwh.run_daily_etl(SECURITY DEFINER)を対象日で実行する。
 * 関数自体が対象日の DELETE→INSERT 洗い替えのため、許可範囲内なら何度実行しても冪等。
 */
export async function runDailyEtl(pool: pg.Pool, params: DailyEtlParams = {}): Promise<JobSummary> {
  const targetDate = params.targetDate ?? jstDateString();
  if (!DATE_PATTERN.test(targetDate) || !isRealDate(targetDate)) {
    throw new AppError(ERROR_CODES.JOB_PARAMS_INVALID, 'targetDate は YYYY-MM-DD 形式で指定してください', {
      status: 400,
      details: { targetDate },
    });
  }
  // 対象日の有界化(TARGET_DATE_MAX_DAYS_AGO のコメント参照)。
  // YYYY-MM-DD は辞書順比較がそのまま日付順比較になる
  const today = jstDateString();
  const oldest = jstDateStringDaysAgo(TARGET_DATE_MAX_DAYS_AGO);
  if (targetDate > today || targetDate < oldest) {
    throw new AppError(
      ERROR_CODES.JOB_PARAMS_INVALID,
      `targetDate は当日から ${TARGET_DATE_MAX_DAYS_AGO} 日前までの範囲で指定してください(未来日と、それ以前の確定済み履歴は再集計できません)`,
      { status: 400, details: { targetDate, oldest, today } },
    );
  }

  try {
    await query(pool, 'SELECT dwh.run_daily_etl($1::date)', [targetDate]);
  } catch (err) {
    // ETL の失敗は集計欠落として運用者が気づく必要があるため、専用コードで包んで返す
    throw new AppError(ERROR_CODES.ETL_FAILED, `集計 ETL の実行に失敗しました(対象日: ${targetDate})`, {
      cause: err,
      details: { targetDate },
    });
  }
  logger.info('集計 ETL を実行しました', { targetDate });
  return { sent: 1, skipped: 0, failed: 0 };
}
