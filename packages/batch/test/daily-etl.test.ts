import { describe, expect, it } from 'vitest';
import { jstDateString, jstDateStringDaysAgo } from '@ai-manager/shared';
import { runDailyEtl } from '../src/jobs/daily-etl.js';
import { createMockPool, findCall } from './mock-pool.js';

describe('runDailyEtl(集計の手動実行 — v0.12 §6)', () => {
  it('targetDate 省略時は当日 JST で dwh.run_daily_etl を実行する(既定は前日でなく当日)', async () => {
    const { pool, calls } = createMockPool();
    const summary = await runDailyEtl(pool);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const etl = findCall(calls, 'dwh.run_daily_etl');
    expect(etl?.text).toContain('SELECT dwh.run_daily_etl($1::date)');
    // 手動実行の目的は「当日の途中経過を今すぐ集計に反映する」。翌日の pg_cron 定時実行が
    // 同じ日を洗い替えるため、当日既定でも巻き戻りは起きない(冪等)
    expect(etl?.params).toEqual([jstDateString()]);
  });

  it('targetDate に当日 JST を明示指定した場合は実行する', async () => {
    const targetDate = jstDateString();
    const { pool, calls } = createMockPool();
    const summary = await runDailyEtl(pool, { targetDate });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'dwh.run_daily_etl')?.params).toEqual([targetDate]);
  });

  it('YYYY-MM-DD 形式でない・実在しない targetDate は AIM-5005(400)で ETL を実行しない', async () => {
    for (const bad of ['2026/07/01', '2026-7-1', '20260701', 'today', '2026-07-01T00:00:00Z', '2026-02-31']) {
      const { pool, calls } = createMockPool();
      await expect(runDailyEtl(pool, { targetDate: bad })).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
      expect(findCall(calls, 'dwh.run_daily_etl')).toBeUndefined();
    }
  });

  it('当日以外の対象日(前日・過去日・未来日)は AIM-5005(400)で拒否する(履歴スナップショットの上書き防止 — 原則2)', async () => {
    // fact_workload は「実行時点の状態」を対象日ラベルで書く日次スナップショットで
    // 遡及再計算できないため、過去日を対象にすると確定済みの履歴が今日の状態で上書きされる。
    // API からは当日のみ許可し、SQL 側の保護(前日より古い対象日は既存行を上書きしない)と
    // 合わせて多層防御とする
    for (const bad of [jstDateStringDaysAgo(1), jstDateStringDaysAgo(8), jstDateStringDaysAgo(-1)]) {
      const { pool, calls } = createMockPool();
      await expect(runDailyEtl(pool, { targetDate: bad })).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
      expect(findCall(calls, 'dwh.run_daily_etl')).toBeUndefined();
    }
  });

  it('ETL の実行失敗は AIM-5006 で包んで返す', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes('dwh.run_daily_etl')) return new Error('etl down');
      return undefined;
    });
    await expect(runDailyEtl(pool, { targetDate: jstDateString() })).rejects.toMatchObject({
      code: 'AIM-5006',
    });
  });
});
