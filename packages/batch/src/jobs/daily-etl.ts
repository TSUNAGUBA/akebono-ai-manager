import { AppError, ERROR_CODES, jstDateString, logger, query } from '@ai-manager/shared';
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
 * 集計 ETL の手動実行(v0.12 §6)。ダッシュボードから OIDC 経由で起動され、
 * dwh.run_daily_etl(SECURITY DEFINER)を対象日で実行する。
 * 関数自体が対象日の DELETE→INSERT 洗い替えのため、何度実行しても冪等。
 */
export async function runDailyEtl(pool: pg.Pool, params: DailyEtlParams = {}): Promise<JobSummary> {
  const targetDate = params.targetDate ?? jstDateString();
  if (!DATE_PATTERN.test(targetDate)) {
    throw new AppError(ERROR_CODES.JOB_PARAMS_INVALID, 'targetDate は YYYY-MM-DD 形式で指定してください', {
      status: 400,
      details: { targetDate },
    });
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
