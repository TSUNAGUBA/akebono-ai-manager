import { AppError, ERROR_CODES, jstDateString, logger, query } from '@ai-manager/shared';
import type pg from 'pg';
import type { JobSummary } from './morning-checkin.js';

/**
 * ジョブパラメータ(v0.12 §6)。
 * targetDate 省略時は当日 JST。手動実行の目的は「当日の途中経過を今すぐ集計に反映する」
 * ため、対象は**当日のみ**を許可する。翌日の pg_cron 定時実行(前日分)が同じ日付を
 * 洗い替えるため、先回りして実行しても集計が巻き戻る副作用はない(原則2)。
 */
export interface DailyEtlParams {
  targetDate?: string;
}

/** YYYY-MM-DD 形式(dwh.run_daily_etl の p_target_date に渡す前の形式検証)。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** カレンダー上実在する日付か(2026-02-31 等を DB エラーにせず 400 で弾く)。 */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 集計 ETL の手動実行(v0.12 §6)。ダッシュボードから OIDC 経由で起動され、
 * dwh.run_daily_etl(SECURITY DEFINER)を対象日で実行する。
 *
 * 対象日は当日(JST)のみ許可する: fact_workload は「その日の状態」の日次スナップショットで
 * 遡って再計算できず、過去日を対象にすると確定済みの履歴が「今日の状態」で上書きされる
 * (原則2: 記録系データの保護)。SQL 側にも前日より古い対象日ではスナップショットを
 * 上書きしないガードがあり(20_daily_etl.sql)、本検証はその手前の一次防御。
 * 過去日の派生ファクトの再集計が必要な場合は、運用者が dwh.run_daily_etl を直接実行する。
 */
export async function runDailyEtl(pool: pg.Pool, params: DailyEtlParams = {}): Promise<JobSummary> {
  const targetDate = params.targetDate ?? jstDateString();
  if (!DATE_PATTERN.test(targetDate) || !isRealDate(targetDate)) {
    throw new AppError(ERROR_CODES.JOB_PARAMS_INVALID, 'targetDate は YYYY-MM-DD 形式で指定してください', {
      status: 400,
      details: { targetDate },
    });
  }
  const today = jstDateString();
  if (targetDate !== today) {
    throw new AppError(
      ERROR_CODES.JOB_PARAMS_INVALID,
      'targetDate は当日(JST)のみ指定できます(fact_workload の履歴スナップショット保護のため、過去日の再集計は API からは行えません)',
      { status: 400, details: { targetDate, today } },
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
