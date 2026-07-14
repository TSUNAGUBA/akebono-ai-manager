import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ERROR_CODES, isAppError } from '@ai-manager/shared';
import type { Viewer } from '../src/render/layout.js';
import type { AdminPageContext } from '../src/pages/admin/common.js';

const mocks = vi.hoisted(() => ({
  getIdTokenFor: vi.fn<(audience: string) => Promise<string>>(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, ...mocks };
});

// vi.mock 適用後に読み込む(モック済みの shared を参照させる)
const { handleAdminJobsPost, renderAdminJobs } = await import('../src/pages/admin/jobs.js');

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/jobs${query}`),
});

/** ジョブ実行ページは DB に触れない(readonly ページ)。クエリが飛んだら失敗させる。 */
const noQueryPool = {
  query: () => {
    throw new Error('ジョブ実行ページは DB クエリを発行しない想定です');
  },
} as unknown as pg.Pool;

async function expectAppErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
  messageContains?: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(isAppError(err), 'AppError であること').toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      if (messageContains !== undefined) expect(err.message).toContain(messageContains);
    }
    return;
  }
  expect.fail('例外が発生しませんでした');
}

function stubFetch(
  response: () => Promise<Response>,
): Array<{ url: string; method?: string; auth?: string; body?: string }> {
  const calls: Array<{ url: string; method?: string; auth?: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers['authorization'],
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return response();
    }),
  );
  return calls;
}

const okResponse = (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ job: 'daily-etl', sent: 1, skipped: 0, failed: 0 }), {
      status: 200,
    }),
  );

let savedBatchUrl: string | undefined;

beforeEach(() => {
  savedBatchUrl = process.env['BATCH_URL'];
  delete process.env['BATCH_URL'];
  mocks.getIdTokenFor.mockReset().mockResolvedValue('id-token');
});

afterEach(() => {
  if (savedBatchUrl === undefined) delete process.env['BATCH_URL'];
  else process.env['BATCH_URL'] = savedBatchUrl;
  vi.unstubAllGlobals();
});

describe('ジョブ実行ページの描画', () => {
  it('定時ジョブの一覧(表示名・定時・説明)と実行ボタンを表示する(v0.12 §6)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminJobs(noQueryPool, adminCtx())).html;

    for (const [label, schedule] of [
      ['集計(日次ETL)', '毎日 02:30'],
      ['朝の問いかけ', '平日 08:00'],
      ['日報生成', '平日 18:00'],
      ['週次サマリ', '金 17:00'],
      ['異常検知', '平日 09:30'],
      ['ナレッジ同期', '毎日 06:30'],
    ]) {
      expect(out).toContain(label);
      expect(out).toContain(schedule);
    }
    // 各ジョブに confirm 付き実行ボタン(二重送信は confirm+PRG で防止)。
    // responsiveTable は PC 表とモバイルカードの2回描画するため、6ジョブ = 12 箇所
    expect(out.match(/>実行<\/button>/g)).toHaveLength(12);
    expect(out).toContain('を今すぐ実行しますか');
    // 冪等性の注意書き
    expect(out).toContain('再実行で既存データが巻き戻らない');
    // 全フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
  });

  it('BATCH_URL 未設定なら実行ボタンを出さず案内を表示する(グレースフルデグラデーション)', async () => {
    const out = (await renderAdminJobs(noQueryPool, adminCtx())).html;
    expect(out).not.toContain('>実行</button>');
    expect(out).toContain('BATCH_URL が未設定');
    // 一覧(定時・説明)自体は表示する
    expect(out).toContain('集計(日次ETL)');
  });

  it('実行結果のフラッシュはジョブ名を whitelist で解決して表示し、数値以外は 0 に丸める', async () => {
    const done = (
      await renderAdminJobs(noQueryPool, adminCtx('?job_done=1&sent=3&skipped=1&failed=<x>&job=daily-etl'))
    ).html;
    expect(done).toContain('「集計(日次ETL)」を実行しました');
    expect(done).toContain('処理 3 件');
    expect(done).not.toContain('<x>');

    // whitelist 外のジョブ名(クエリ偽装)は総称にフォールバックする
    const forged = (
      await renderAdminJobs(noQueryPool, adminCtx('?job_done=1&sent=1&skipped=0&failed=0&job=<img>'))
    ).html;
    expect(forged).toContain('「ジョブ」を実行しました');
    expect(forged).not.toContain('<img>');

    // JobSummary の failed>0 は AIM-6011 の案内つきエラー表示
    const failed = (
      await renderAdminJobs(noQueryPool, adminCtx('?job_done=1&sent=0&skipped=0&failed=2&job=daily-report'))
    ).html;
    expect(failed).toContain('AIM-6011');

    const errored = (await renderAdminJobs(noQueryPool, adminCtx('?job_error=request&job=knowledge-sync')))
      .html;
    expect(errored).toContain('「ナレッジ同期」');
    expect(errored).toContain('AIM-6011');

    // 継承プロパティ名はメッセージ扱いしない
    const ignored = (await renderAdminJobs(noQueryPool, adminCtx('?job_error=toString'))).html;
    expect(ignored).not.toContain('alert error');
  });
});

describe('ジョブ実行ハンドラ(POST)', () => {
  it('BATCH_URL 未設定は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminJobsPost(noQueryPool, viewer, new URLSearchParams({ action: 'run', job: 'daily-etl' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'BATCH_URL',
    );
  });

  it('run: OIDC ID トークン付きで /jobs/{name} をボディなしで起動し、結果とジョブ名を PRG で渡す', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);

    const location = await handleAdminJobsPost(
      noQueryPool,
      viewer,
      new URLSearchParams({ action: 'run', job: 'daily-etl' }),
    );

    expect(mocks.getIdTokenFor).toHaveBeenCalledWith('https://batch.example.run.app');
    // ボディなし = 既定動作(daily-etl は当日 JST の洗い替え — v0.12 §6)
    expect(fetchCalls).toEqual([
      {
        url: 'https://batch.example.run.app/jobs/daily-etl',
        method: 'POST',
        auth: 'Bearer id-token',
        body: undefined,
      },
    ]);
    expect(location).toBe('/admin/jobs?job_done=1&sent=1&skipped=0&failed=0&job=daily-etl');
  });

  it('run: whitelist の全ジョブを起動できる', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const jobs = [
      'daily-etl',
      'morning-checkin',
      'daily-report',
      'weekly-summary',
      'anomaly-scan',
      'knowledge-sync',
    ];
    for (const job of jobs) {
      await handleAdminJobsPost(noQueryPool, viewer, new URLSearchParams({ action: 'run', job }));
    }
    expect(fetchCalls.map((c) => c.url)).toEqual(
      jobs.map((job) => `https://batch.example.run.app/jobs/${job}`),
    );
  });

  it('whitelist 外のジョブ(パラメータ必須ジョブ・未知ジョブ)は AIM-6004(400)で起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    for (const job of ['escalation-action', 'dialogue-feedback', 'adhoc-checkin', 'ghost', '']) {
      await expectAppErrorAsync(
        () => handleAdminJobsPost(noQueryPool, viewer, new URLSearchParams({ action: 'run', job })),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
      );
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminJobsPost(noQueryPool, viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('起動失敗・タイムアウトは例外にせず job_error へ PRG する(再読み込みで再実行しない)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    stubFetch(() => Promise.reject(new Error('connect failed')));
    const location = await handleAdminJobsPost(
      noQueryPool,
      viewer,
      new URLSearchParams({ action: 'run', job: 'anomaly-scan' }),
    );
    expect(location).toBe('/admin/jobs?job_error=request&job=anomaly-scan');

    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    stubFetch(() => Promise.reject(timeoutError));
    const timedOut = await handleAdminJobsPost(
      noQueryPool,
      viewer,
      new URLSearchParams({ action: 'run', job: 'weekly-summary' }),
    );
    expect(timedOut).toBe('/admin/jobs?job_error=timeout&job=weekly-summary');
  });
});
