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
const { handleAdminCheckinPost, renderAdminCheckin } = await import('../src/pages/admin/checkin.js');
const { createDashboardServer } = await import('../src/server.js');

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/checkin${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

const memberRows = [
  {
    user_id: 'member1',
    display_name: '田中',
    dm_ready: true,
    morning_sent: true,
    morning_answered: false,
    adhoc_sent: true,
    adhoc_answered: false,
  },
  {
    user_id: 'member2',
    display_name: '佐藤',
    dm_ready: false,
    morning_sent: false,
    morning_answered: false,
    adhoc_sent: false,
    adhoc_answered: false,
  },
];

/** SQL とパラメータを捕捉するスタブプール(knowledge.test.ts と同旨)。 */
function stubPool(
  captured: CapturedCall[] = [],
  behavior: { rows?: unknown[]; rowCount?: number } = {},
): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      const rows = text.includes('FROM ops.users u') ? (behavior.rows ?? memberRows) : [];
      return Promise.resolve({ rows, rowCount: behavior.rowCount ?? rows.length });
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

describe('状況確認ページの描画', () => {
  it('active メンバーの一覧と当日の応答状況を閲覧用ロールの範囲(users+集計ビュー)で表示する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const captured: CapturedCall[] = [];
    const out = (await renderAdminCheckin(stubPool(captured), adminCtx())).html;

    assertCallsValid(captured);
    // 生の対話ログ(ops.dialogues)には触れず、集計ビューのみ参照する(プライバシー境界)
    const listQuery = captured[0]?.text ?? '';
    expect(listQuery).toContain('ops.v_dialogue_daily_stats');
    expect(listQuery).not.toContain('FROM ops.dialogues');
    // 一覧+状態バッジ
    expect(out).toContain('田中');
    expect(out).toContain('未応答'); // 朝: 配信済み・仮説未確定
    expect(out).toContain('返信待ち'); // 状況確認: 送信済み・返信なし
    expect(out).toContain('未登録'); // DM 未登録
    // 全フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
    // サブナビに状況確認タブ
    expect(out).toContain('/admin/checkin');
  });

  it('集計ビューの拡張列が未反映でも一覧・送信は継続し、状況列は「不明」に落とす(原則4)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const pool = {
      query: (text: string) => {
        if (text.includes('v_dialogue_daily_stats')) {
          return Promise.reject(new Error('column s.adhoc_checkin_sent does not exist'));
        }
        return Promise.resolve({
          rows: [{ user_id: 'member1', display_name: '田中', dm_ready: true }],
          rowCount: 1,
        });
      },
    } as unknown as pg.Pool;

    const out = (await renderAdminCheckin(pool, adminCtx())).html;
    expect(out).toContain('田中');
    expect(out).toContain('不明');
    expect(out).toContain('db-migrate');
    expect(out).toContain('>問いかける</button>'); // 送信は止めない
  });

  it('DM 未登録メンバーの個別ボタンは無効化される(送信してもスキップされる旨を明示)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminCheckin(stubPool(), adminCtx())).html;
    expect(out).toContain('member2');
    expect(out).toContain('disabled title="DM スペース未登録のため送信できません');
  });

  it('BATCH_URL 未設定なら送信ボタンを出さず案内を表示する', async () => {
    const out = (await renderAdminCheckin(stubPool(), adminCtx())).html;
    expect(out).not.toContain('>問いかける</button>');
    expect(out).not.toContain('>全員に問いかける</button>');
    expect(out).toContain('BATCH_URL が未設定');
  });

  it('BATCH_URL 設定時は個別・全員の送信ボタンを表示する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminCheckin(stubPool(), adminCtx())).html;
    expect(out).toContain('>問いかける</button>');
    expect(out).toContain('>全員に問いかける</button>');
    // hidden user_id で個別送信する
    expect(out).toContain('name="user_id" value="member1"');
  });

  it('送信結果のフラッシュ(?checkin=1)を表示し、数値以外は 0 に丸める', async () => {
    const out = (
      await renderAdminCheckin(stubPool(), adminCtx('?checkin=1&sent=3&skipped=1&failed=<x>'))
    ).html;
    expect(out).toContain('状況確認を送信しました');
    expect(out).toContain('送信 3 件');
    expect(out).toContain('スキップ 1 件');
    expect(out).not.toContain('<x>');
  });

  it('起動失敗のフラッシュ(?checkin_error=)を表示する(継承プロパティ名は無視)', async () => {
    const errored = (await renderAdminCheckin(stubPool(), adminCtx('?checkin_error=request'))).html;
    expect(errored).toContain('AIM-6008');
    const ignored = (await renderAdminCheckin(stubPool(), adminCtx('?checkin_error=toString'))).html;
    expect(ignored).not.toContain('alert error');
  });
});

describe('状況確認の送信ハンドラ(POST)', () => {
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
      new Response(JSON.stringify({ job: 'adhoc-checkin', sent: 1, skipped: 0, failed: 0 }), {
        status: 200,
      }),
    );

  it('BATCH_URL 未設定は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminCheckinPost(stubPool(), viewer, new URLSearchParams({ action: 'send_all' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'BATCH_URL',
    );
  });

  it('send_all: OIDC ID トークン付きで /jobs/adhoc-checkin を空ボディ({})で起動し PRG で結果を渡す', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);

    const location = await handleAdminCheckinPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'send_all' }),
    );

    expect(mocks.getIdTokenFor).toHaveBeenCalledWith('https://batch.example.run.app');
    expect(fetchCalls).toEqual([
      {
        url: 'https://batch.example.run.app/jobs/adhoc-checkin',
        method: 'POST',
        auth: 'Bearer id-token',
        body: '{}',
      },
    ]);
    expect(location).toBe('/admin/checkin?checkin=1&sent=1&skipped=0&failed=0');
  });

  it('send: 対象を SoT(ops.users)で検証してから userId をボディで渡す', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const captured: CapturedCall[] = [];

    const location = await handleAdminCheckinPost(
      stubPool(captured, { rowCount: 1 }),
      viewer,
      new URLSearchParams({ action: 'send', user_id: 'member1' }),
    );

    assertCallsValid(captured);
    expect(captured[0]?.text).toContain('FROM ops.users');
    expect(captured[0]?.params).toEqual(['member1']);
    expect(fetchCalls[0]?.body).toBe(JSON.stringify({ userId: 'member1' }));
    expect(location).toBe('/admin/checkin?checkin=1&sent=1&skipped=0&failed=0');
  });

  it('send: 対象が見つからない(rowCount=0)場合は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminCheckinPost(
          stubPool([], { rowCount: 0 }),
          viewer,
          new URLSearchParams({ action: 'send', user_id: 'ghost' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('send: user_id 未指定は AIM-6004(400)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    await expectAppErrorAsync(
      () => handleAdminCheckinPost(stubPool(), viewer, new URLSearchParams({ action: 'send' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('起動失敗は例外にせず checkin_error=request へ PRG する(再読み込みで再送しない)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    stubFetch(() => Promise.reject(new Error('connect failed')));
    const location = await handleAdminCheckinPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'send_all' }),
    );
    expect(location).toBe('/admin/checkin?checkin_error=request');
  });

  it('エラー応答(500)も checkin_error=request へ PRG する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    stubFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
    const location = await handleAdminCheckinPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'send_all' }),
    );
    expect(location).toBe('/admin/checkin?checkin_error=request');
  });

  it('応答待ちのタイムアウトは checkin_error=timeout へ PRG する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    stubFetch(() => Promise.reject(timeoutError));
    const location = await handleAdminCheckinPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'send_all' }),
    );
    expect(location).toBe('/admin/checkin?checkin_error=timeout');
  });

  it('不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminCheckinPost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('/admin/checkin のアクセス制御(HTTP 統合)', () => {
  it('member ロールは GET / POST とも 403 になる(受け入れ基準3)', async () => {
    const prevAuthMode = process.env['AUTH_MODE'];
    process.env['AUTH_MODE'] = 'header';
    // 認証(ops.users 照会)には常に member を返すスタブを使う
    const usersPool = {
      query: () =>
        Promise.resolve({
          rows: [{ user_id: 'm1', display_name: 'メンバー', email: 'm@example.com', role: 'member' }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    // /admin/checkin は readonly プールで動く(adminPool 不要)からこそ、
    // ロールのガードがルーティング層で確実に効くことをサーバーレベルで検証する
    const server = createDashboardServer(usersPool);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      for (const method of ['GET', 'POST'] as const) {
        const res = await fetch(`http://127.0.0.1:${port}/admin/checkin`, {
          method,
          headers: {
            'x-goog-authenticated-user-email': 'accounts.google.com:m@example.com',
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: method === 'POST' ? 'action=send_all' : undefined,
        });
        expect(res.status, `${method} /admin/checkin`).toBe(403);
        expect(await res.text()).toContain('アクセスできません');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevAuthMode === undefined) delete process.env['AUTH_MODE'];
      else process.env['AUTH_MODE'] = prevAuthMode;
    }
  });
});
