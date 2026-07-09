import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Viewer } from '../src/render/layout.js';
import { renderCost } from '../src/pages/cost.js';
import { renderGrowth } from '../src/pages/growth.js';
import { renderMe } from '../src/pages/me.js';
import { renderOverview } from '../src/pages/overview.js';
import { renderProjects } from '../src/pages/projects.js';
import { renderWorkload } from '../src/pages/workload.js';
import type { AdminPageContext } from '../src/pages/admin/common.js';
import { handleAdminCustomersPost, renderAdminCustomers } from '../src/pages/admin/customers.js';
import { handleAdminIndustriesPost, renderAdminIndustries } from '../src/pages/admin/industries.js';
import { handleAdminRelationsPost, renderAdminRelations } from '../src/pages/admin/relations.js';

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
  const capture = (text: string, params?: unknown[]) => {
    captured.push({ text, params: params ?? [] });
    // rowCount は「対象が見つからない」分岐に入らないよう 1 を返す
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  return {
    query: capture,
    // withClient / withTransaction(トランザクション書込)用の接続スタブ
    connect: () => Promise.resolve({ query: capture, release: () => undefined }),
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

describe('マスタ管理ページの SQL パラメータ整合', () => {
  const adminCtx = (path: string): AdminPageContext => ({
    csrfToken: 'a'.repeat(64),
    url: new URL(`http://localhost${path}`),
  });

  const adminPages: Array<[string, string, (pool: pg.Pool, ctx: AdminPageContext) => Promise<unknown>]> = [
    ['admin/industries', '/admin/industries', renderAdminIndustries],
    ['admin/customers', '/admin/customers', renderAdminCustomers],
    ['admin/relations', '/admin/relations', renderAdminRelations],
  ];

  for (const [name, path, render] of adminPages) {
    it(`${name}(GET): 実行された全クエリでプレースホルダ数とパラメータ数が一致する`, async () => {
      const captured: CapturedCall[] = [];
      await render(stubPool(captured), adminCtx(path));
      assertCallsValid(captured);
    });
  }

  const posts: Array<[string, (pool: pg.Pool) => Promise<string>]> = [
    [
      'industries create',
      (pool) =>
        handleAdminIndustriesPost(
          pool,
          viewer,
          new URLSearchParams({ action: 'create', industry_id: 'retail', name: '小売業', display_order: '10', active: 'on' }),
        ),
    ],
    [
      'industries update',
      (pool) =>
        handleAdminIndustriesPost(
          pool,
          viewer,
          new URLSearchParams({ action: 'update', industry_id: 'retail', name: '小売業' }),
        ),
    ],
    [
      'customers create(トランザクション)',
      (pool) => {
        const form = new URLSearchParams({
          action: 'create',
          customer_id: 'shimamura',
          name: 'しまむら',
          primary_industry: 'retail',
        });
        form.append('industries', 'retail');
        form.append('industries', 'apparel');
        return handleAdminCustomersPost(pool, viewer, form);
      },
    ],
    [
      'customers update(トランザクション)',
      (pool) => {
        const form = new URLSearchParams({
          action: 'update',
          customer_id: 'shimamura',
          name: 'しまむら',
          primary_industry: 'retail',
        });
        form.append('industries', 'retail');
        return handleAdminCustomersPost(pool, viewer, form);
      },
    ],
    [
      'relations create_relation',
      (pool) =>
        handleAdminRelationsPost(
          pool,
          viewer,
          new URLSearchParams({
            action: 'create_relation',
            from_customer_id: 'undeux',
            to_customer_id: 'shimamura',
            relation_type: 'supplies_to',
            notes: 'テスト',
          }),
        ),
    ],
    [
      'relations delete_relation',
      (pool) =>
        handleAdminRelationsPost(
          pool,
          viewer,
          new URLSearchParams({
            action: 'delete_relation',
            from_customer_id: 'undeux',
            to_customer_id: 'shimamura',
            relation_type: 'supplies_to',
          }),
        ),
    ],
    [
      'relations create_type',
      (pool) =>
        handleAdminRelationsPost(
          pool,
          viewer,
          new URLSearchParams({ action: 'create_type', relation_type: 'sells_via', label: '販売チャネル', active: 'on' }),
        ),
    ],
    [
      'relations update_type',
      (pool) =>
        handleAdminRelationsPost(
          pool,
          viewer,
          new URLSearchParams({ action: 'update_type', relation_type: 'sells_via', label: '販売チャネル' }),
        ),
    ],
  ];

  for (const [name, run] of posts) {
    it(`${name}(POST): 実行された全クエリでプレースホルダ数とパラメータ数が一致する`, async () => {
      const captured: CapturedCall[] = [];
      const location = await run(stubPool(captured));
      assertCallsValid(captured);
      // PRG パターン: 成功時はリダイレクト先(?saved=)を返す
      expect(location).toContain('saved=');
    });
  }
});
