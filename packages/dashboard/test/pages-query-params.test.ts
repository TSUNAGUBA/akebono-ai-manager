import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Viewer } from '../src/render/layout.js';
import { renderCost } from '../src/pages/cost.js';
import { renderGrowth } from '../src/pages/growth.js';
import { renderMe } from '../src/pages/me.js';
import { renderOverview } from '../src/pages/overview.js';
import { renderProjects } from '../src/pages/projects.js';
import { renderWorkload } from '../src/pages/workload.js';

/**
 * 本番で発生した SQLSTATE 42P02(there is no parameter $1)の回帰テスト。
 * SQL 中の $N プレースホルダ数と、query() に渡すパラメータ配列の長さの
 * 不一致を、モックプールで捕捉して検出する(モック DB のため実行計画までは検証しない)。
 */
interface CapturedCall {
  text: string;
  params: unknown[];
}

function stubPool(captured: CapturedCall[]): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as pg.Pool;
}

function maxPlaceholder(sql: string): number {
  const matches = sql.match(/\$(\d+)/g) ?? [];
  return matches.reduce((max, m) => Math.max(max, Number(m.slice(1))), 0);
}

function assertCallsValid(captured: CapturedCall[]): void {
  expect(captured.length).toBeGreaterThan(0);
  for (const call of captured) {
    const expected = maxPlaceholder(call.text);
    expect(
      call.params.length,
      `プレースホルダ $${expected} 個に対しパラメータ ${call.params.length} 個: ${call.text.slice(0, 80)}`,
    ).toBe(expected);
  }
}

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };

describe('ダッシュボード各ページの SQL パラメータ整合', () => {
  it('projects: $1(基準日)を渡している(42P02 回帰)', async () => {
    const captured: CapturedCall[] = [];
    await renderProjects(stubPool(captured));
    assertCallsValid(captured);
    expect(captured.length).toBe(2);
  });

  const pages: Array<[string, (pool: pg.Pool) => Promise<unknown>]> = [
    ['overview', (pool) => renderOverview(pool)],
    ['cost', (pool) => renderCost(pool)],
    ['growth', (pool) => renderGrowth(pool)],
    ['workload', (pool) => renderWorkload(pool)],
    ['me', (pool) => renderMe(pool, viewer)],
  ];

  for (const [name, render] of pages) {
    it(`${name}: 実行された全クエリでプレースホルダ数とパラメータ数が一致する`, async () => {
      const captured: CapturedCall[] = [];
      // 空行データでの描画クラッシュもこのテストで検知する(握りつぶさない)
      await render(stubPool(captured));
      assertCallsValid(captured);
    });
  }
});
