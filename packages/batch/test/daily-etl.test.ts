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

  it('targetDate 指定時はその日付で実行する(許容範囲内の過去日の再集計)', async () => {
    const targetDate = jstDateStringDaysAgo(3);
    const { pool, calls } = createMockPool();
    const summary = await runDailyEtl(pool, { targetDate });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'dwh.run_daily_etl')?.params).toEqual([targetDate]);
  });

  it('遡り上限(7日前)ちょうどは許可する(境界値)', async () => {
    const targetDate = jstDateStringDaysAgo(7);
    const { pool, calls } = createMockPool();
    await expect(runDailyEtl(pool, { targetDate })).resolves.toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
    });
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

  it('範囲外の対象日(8日前・未来日)は AIM-5005(400)で拒否する(確定済み履歴の上書き防止 — 原則2)', async () => {
    // fact_workload は日次スナップショットで遡及再計算できないため、定時 ETL の
    // ルックバック範囲(7日)を超える過去日の洗い替えは履歴を「今日の状態」で壊す
    for (const bad of [jstDateStringDaysAgo(8), jstDateStringDaysAgo(-1)]) {
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
    await expect(runDailyEtl(pool, { targetDate: jstDateStringDaysAgo(1) })).rejects.toMatchObject({
      code: 'AIM-5006',
    });
  });
});
