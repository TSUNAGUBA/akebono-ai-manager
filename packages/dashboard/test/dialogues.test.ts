import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ERROR_CODES, isAppError, jstDateString } from '@ai-manager/shared';
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
const { handleAdminDialoguesPost, renderAdminDialogues } = await import(
  '../src/pages/admin/dialogues.js'
);
const { createDashboardServer } = await import('../src/server.js');

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/dialogues${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

const userRows = [
  { user_id: 'member1', display_name: '田中' },
  { user_id: 'member2', display_name: '佐藤' },
];

const dialogueRows = [
  {
    dialogue_id: '5',
    created_iso: '2026-07-13T00:00:00.000000Z',
    created_jst: '09:00',
    user_id: 'member1',
    display_name: '田中',
    dialogue_type: 'morning_checkin',
    turns: [
      { role: 'ai', content: '今日の見通しを教えてください', ts: 't1' },
      { role: 'user', content: '<script>alert(1)</script>\n改行あり', ts: 't2' },
    ],
  },
  {
    dialogue_id: '6',
    created_iso: '2026-07-13T03:00:00.000000Z',
    created_jst: '12:00',
    user_id: 'member2',
    display_name: '佐藤',
    dialogue_type: 'adhoc_qa',
    turns: [],
  },
];

const feedbackRows = [
  {
    feedback_id: '11',
    dialogue_id: '5',
    status: 'pending',
    feedback: '正しくは B 案です',
    knowledge_reflected: false,
    created_jst: '2026-07-13 10:00',
    delivered_jst: null,
  },
  {
    feedback_id: '12',
    dialogue_id: '6',
    status: 'delivered',
    feedback: '訂正済みの指摘',
    knowledge_reflected: false, // 送達済み・還流未了 → 「ナレッジ再還流」の対象
    created_jst: '2026-07-13 11:00',
    delivered_jst: '2026-07-13 11:05',
  },
  {
    feedback_id: '13',
    dialogue_id: '5',
    status: 'delivered',
    feedback: '還流まで完了した指摘',
    knowledge_reflected: true, // 還流済み → 再還流ボタンは出さない
    created_jst: '2026-07-13 09:30',
    delivered_jst: '2026-07-13 09:35',
  },
];

/** SQL とパラメータを捕捉するスタブプール(checkin.test.ts と同旨)。 */
function stubPool(
  captured: CapturedCall[] = [],
  behavior: { dialogueRows?: unknown[]; feedbackRows?: unknown[]; resendRows?: unknown[] } = {},
): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      let rows: unknown[] = [];
      if (text.includes('FROM ops.users')) rows = userRows;
      else if (text.includes('FROM ops.dialogues')) rows = behavior.dialogueRows ?? dialogueRows;
      else if (text.includes('WHERE feedback_id')) {
        rows = behavior.resendRows ?? [{ dialogue_id: '5' }];
      } else if (text.includes('FROM ops.dialogue_feedback')) {
        rows = behavior.feedbackRows ?? feedbackRows;
      }
      return Promise.resolve({ rows, rowCount: rows.length });
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
    new Response(JSON.stringify({ job: 'dialogue-feedback', sent: 1, skipped: 0, failed: 0 }), {
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

describe('対話ログページの描画', () => {
  it('当日 JST の対話一覧を種別ラベル・ターン数付きで表示し、フィルタの既定は当日・全ユーザー', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const captured: CapturedCall[] = [];
    const out = (await renderAdminDialogues(stubPool(captured), adminCtx())).html;

    assertCallsValid(captured);
    // 既定は当日 JST・全ユーザー(user は NULL)
    const dialogueQuery = captured.find((c) => c.text.includes('FROM ops.dialogues'));
    expect(dialogueQuery?.params).toEqual([jstDateString(), null]);
    // 一覧: 時刻・ユーザー名・種別ラベル・ターン数
    expect(out).toContain('09:00');
    expect(out).toContain('田中');
    expect(out).toContain('朝の問いかけ');
    expect(out).toContain('随時QA');
    // フィルタ(ユーザー select+日付)
    expect(out).toContain('<select name="user">');
    expect(out).toContain('全ユーザー');
    expect(out).toContain(`name="date" value="${jstDateString()}"`);
    // 全 POST フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
  });

  it('turns の内容を <details> で展開表示し、本人/AI ラベル付きで HTML エスケープする(v0.12 §7)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminDialogues(stubPool(), adminCtx())).html;

    expect(out).toContain('対話を表示');
    expect(out).toContain('>AI</span>');
    expect(out).toContain('>本人</span>');
    expect(out).toContain('今日の見通しを教えてください');
    // ユーザー入力はエスケープされ、生の HTML として出ない
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('フィードバックフォームは dialogueCreatedAt(ISO)を hidden で送信し、アンカー先カードにある', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminDialogues(stubPool(), adminCtx())).html;

    expect(out).toContain('id="dialogue-5"');
    expect(out).toContain('name="dialogue_created_at" value="2026-07-13T00:00:00.000000Z"');
    expect(out).toContain('<textarea name="feedback"');
    expect(out).toContain('正しい回答・指摘(AI がお詫びと訂正を本人へ送ります)');
    // 誤クリック・二重送信の防止(confirm+PRG)
    expect(out).toContain('このフィードバックを送信しますか');
  });

  it('既存フィードバックの状態を表示する(pending=再送ボタン付き / delivered=送信日時)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminDialogues(stubPool(), adminCtx())).html;

    expect(out).toContain('訂正送信待ち');
    expect(out).toContain('name="feedback_id" value="11"');
    expect(out).toContain('>再送</button>');
    expect(out).toContain('訂正送信済み');
    expect(out).toContain('2026-07-13 11:05');
    // 再送ボタンは pending の1件のみ(delivered には出さない)
    expect(out.match(/value="resend"/g)).toHaveLength(1);
  });

  it('還流状態(還流済み/未還流)を表示し、送達済み・還流未了にのみ「ナレッジ再還流」を出す', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminDialogues(stubPool(), adminCtx())).html;

    expect(out).toContain('>還流済み<');
    expect(out).toContain('>未還流<');
    expect(out).toContain('>ナレッジ再還流</button>');
    // 対象は #12(delivered・未還流)のみ。#11(pending)・#13(還流済み)には出さない
    expect(out.match(/value="reflux"/g)).toHaveLength(1);
    expect(out).toContain('ナレッジ還流を再試行しますか');
  });

  it('フィルタ(ユーザー・日付)をクエリに反映し、不正な日付は当日 JST へ落とす', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const captured: CapturedCall[] = [];
    const out = (
      await renderAdminDialogues(stubPool(captured), adminCtx('?user=member1&date=2026-07-10'))
    ).html;
    const dialogueQuery = captured.find((c) => c.text.includes('FROM ops.dialogues'));
    expect(dialogueQuery?.params).toEqual(['2026-07-10', 'member1']);
    expect(out).toContain(`value="member1" selected`);

    const invalid: CapturedCall[] = [];
    await renderAdminDialogues(stubPool(invalid), adminCtx('?date=2026-02-31'));
    const fallbackQuery = invalid.find((c) => c.text.includes('FROM ops.dialogues'));
    expect(fallbackQuery?.params).toEqual([jstDateString(), null]);
  });

  it('BATCH_URL 未設定ならフィードバックフォームを出さず案内を表示する', async () => {
    const out = (await renderAdminDialogues(stubPool(), adminCtx())).html;
    expect(out).not.toContain('<textarea name="feedback"');
    expect(out).not.toContain('value="resend"');
    expect(out).toContain('BATCH_URL が未設定');
  });

  it('送信結果のフラッシュ(成功・失敗・エラー)を表示する', async () => {
    const ok = (await renderAdminDialogues(stubPool(), adminCtx('?feedback=1&sent=1&skipped=0&failed=0')))
      .html;
    expect(ok).toContain('お詫びと訂正を本人へ送ります');

    const resent = (
      await renderAdminDialogues(stubPool(), adminCtx('?feedback_resent=1&sent=1&skipped=0&failed=0'))
    ).html;
    expect(resent).toContain('再送しました');

    const refluxed = (
      await renderAdminDialogues(stubPool(), adminCtx('?feedback_refluxed=1&sent=1&skipped=0&failed=0'))
    ).html;
    expect(refluxed).toContain('ナレッジへ再還流しました');

    // JobSummary の failed>0 は AIM-6010 の案内つきエラー表示
    const failed = (
      await renderAdminDialogues(stubPool(), adminCtx('?feedback=1&sent=0&skipped=0&failed=1'))
    ).html;
    expect(failed).toContain('AIM-6010');

    const errored = (await renderAdminDialogues(stubPool(), adminCtx('?feedback_error=request'))).html;
    expect(errored).toContain('AIM-6010');

    // 継承プロパティ名はメッセージ扱いしない
    const ignored = (await renderAdminDialogues(stubPool(), adminCtx('?feedback_error=toString'))).html;
    expect(ignored).not.toContain('alert error');
  });
});

describe('対話フィードバックハンドラ(POST)', () => {
  it('BATCH_URL 未設定は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminDialoguesPost(
          stubPool(),
          viewer,
          new URLSearchParams({
            action: 'feedback',
            dialogue_id: '5',
            dialogue_created_at: '2026-07-13T00:00:00.000000Z',
            feedback: '指摘',
          }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'BATCH_URL',
    );
  });

  it('feedback: 契約どおりのボディで /jobs/dialogue-feedback を起動し、フィルタを引き継いで PRG する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);

    const location = await handleAdminDialoguesPost(
      stubPool(),
      viewer,
      new URLSearchParams({
        action: 'feedback',
        dialogue_id: '5',
        dialogue_created_at: '2026-07-13T00:00:00.000000Z',
        feedback: '誤りです。正しくは B 案です',
        filter_user: 'member1',
        filter_date: '2026-07-13',
      }),
    );

    expect(mocks.getIdTokenFor).toHaveBeenCalledWith('https://batch.example.run.app');
    expect(fetchCalls).toEqual([
      {
        url: 'https://batch.example.run.app/jobs/dialogue-feedback',
        method: 'POST',
        auth: 'Bearer id-token',
        body: JSON.stringify({
          dialogueId: '5',
          dialogueCreatedAt: '2026-07-13T00:00:00.000000Z',
          feedback: '誤りです。正しくは B 案です',
          operatorUserId: 'u1',
        }),
      },
    ]);
    // PRG: フィルタ(ユーザー・日付)を引き継ぎ、操作した対話のアンカーへ戻る
    expect(location).toBe(
      '/admin/dialogues?user=member1&date=2026-07-13&feedback=1&sent=1&skipped=0&failed=0#dialogue-5',
    );
  });

  it('feedback: 本文必須(未入力・2000字超)と日時不正は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    for (const overrides of [
      { feedback: '' },
      { feedback: 'x'.repeat(2001) },
      { dialogue_created_at: 'not-a-date' },
      { dialogue_id: 'abc' },
    ]) {
      await expectAppErrorAsync(
        () =>
          handleAdminDialoguesPost(
            stubPool(),
            viewer,
            new URLSearchParams({
              action: 'feedback',
              dialogue_id: '5',
              dialogue_created_at: '2026-07-13T00:00:00.000000Z',
              feedback: '指摘',
              ...overrides,
            }),
          ),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
      );
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('resend: pending を SoT で検証し、feedbackId + operatorUserId のボディで再起動する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const captured: CapturedCall[] = [];

    const location = await handleAdminDialoguesPost(
      stubPool(captured),
      viewer,
      new URLSearchParams({ action: 'resend', feedback_id: '11', filter_date: '2026-07-13' }),
    );

    assertCallsValid(captured);
    expect(captured[0]?.text).toContain(`status = 'pending'`);
    expect(captured[0]?.params).toEqual(['11']);
    expect(fetchCalls[0]?.body).toBe(JSON.stringify({ feedbackId: '11', operatorUserId: 'u1' }));
    expect(location).toBe(
      '/admin/dialogues?date=2026-07-13&feedback_resent=1&sent=1&skipped=0&failed=0#dialogue-5',
    );
  });

  it('reflux: delivered・還流未了を SoT で検証し、refluxOnly 付きボディで再還流を起動する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const captured: CapturedCall[] = [];

    const location = await handleAdminDialoguesPost(
      stubPool(captured),
      viewer,
      new URLSearchParams({ action: 'reflux', feedback_id: '12', filter_date: '2026-07-13' }),
    );

    assertCallsValid(captured);
    expect(captured[0]?.text).toContain(`status = 'delivered'`);
    expect(captured[0]?.text).toContain('NOT knowledge_reflected');
    expect(captured[0]?.params).toEqual(['12']);
    // 還流のみ再試行(訂正メッセージは再送しない)— batch との契約
    expect(fetchCalls[0]?.body).toBe(
      JSON.stringify({ feedbackId: '12', refluxOnly: 'true', operatorUserId: 'u1' }),
    );
    expect(location).toBe(
      '/admin/dialogues?date=2026-07-13&feedback_refluxed=1&sent=1&skipped=0&failed=0#dialogue-5',
    );
  });

  it('reflux: 対象外(還流済み・未送達)は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminDialoguesPost(
          stubPool([], { resendRows: [] }),
          viewer,
          new URLSearchParams({ action: 'reflux', feedback_id: '13' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '再還流できるフィードバックが見つかりません',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('resend: 送信済み(pending でない)は AIM-6004(400)で batch を起動しない(二重送信防止)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminDialoguesPost(
          stubPool([], { resendRows: [] }),
          viewer,
          new URLSearchParams({ action: 'resend', feedback_id: '12' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '再送できるフィードバックが見つかりません',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('起動失敗は例外にせず feedback_error=request へ PRG する(再読み込みで再送しない)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    stubFetch(() => Promise.reject(new Error('connect failed')));
    const location = await handleAdminDialoguesPost(
      stubPool(),
      viewer,
      new URLSearchParams({
        action: 'feedback',
        dialogue_id: '5',
        dialogue_created_at: '2026-07-13T00:00:00.000000Z',
        feedback: '指摘',
      }),
    );
    expect(location).toBe('/admin/dialogues?feedback_error=request#dialogue-5');
  });

  it('不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminDialoguesPost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('/admin/dialogues のアクセス制御(HTTP 統合)', () => {
  it('admin プール未構成なら案内(renderAdminUnconfigured)を表示し、生の対話ログには触れない', async () => {
    const prevAuthMode = process.env['AUTH_MODE'];
    process.env['AUTH_MODE'] = 'header';
    // 認証(ops.users 照会)には常に admin を返すスタブを使う
    const usersPool = {
      query: () =>
        Promise.resolve({
          rows: [{ user_id: 'u1', display_name: 'テスト', email: 't@example.com', role: 'admin' }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    // adminPool を渡さない = DB_ADMIN_USER 未構成の状態
    const server = createDashboardServer(usersPool);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/dialogues`, {
        headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:t@example.com' },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('マスタ管理は未構成です');
      // 書込(POST)は 503(グレースフルデグラデーション)
      const post = await fetch(`http://127.0.0.1:${port}/admin/dialogues`, {
        method: 'POST',
        headers: {
          'x-goog-authenticated-user-email': 'accounts.google.com:t@example.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'action=feedback',
      });
      expect(post.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevAuthMode === undefined) delete process.env['AUTH_MODE'];
      else process.env['AUTH_MODE'] = prevAuthMode;
    }
  });

  it('member ロールは GET / POST とも 403 になる(生の対話ログの境界 — 要件 7.5)', async () => {
    const prevAuthMode = process.env['AUTH_MODE'];
    process.env['AUTH_MODE'] = 'header';
    const usersPool = {
      query: () =>
        Promise.resolve({
          rows: [{ user_id: 'm1', display_name: 'メンバー', email: 'm@example.com', role: 'member' }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    const server = createDashboardServer(usersPool, stubPool());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      for (const method of ['GET', 'POST'] as const) {
        const res = await fetch(`http://127.0.0.1:${port}/admin/dialogues`, {
          method,
          headers: {
            'x-goog-authenticated-user-email': 'accounts.google.com:m@example.com',
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: method === 'POST' ? 'action=feedback' : undefined,
        });
        expect(res.status, `${method} /admin/dialogues`).toBe(403);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevAuthMode === undefined) delete process.env['AUTH_MODE'];
      else process.env['AUTH_MODE'] = prevAuthMode;
    }
  });
});
