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
const { handleAdminEscalationsPost, renderAdminEscalations } = await import(
  '../src/pages/admin/escalations.js'
);

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/escalations${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

const openRows = [
  {
    escalation_id: '1',
    reason: 'low_confidence',
    context: 'A社の値引き判断に迷っています',
    status: 'open',
    resolution: null,
    resolution_type: null,
    knowledge_reflected: false,
    related_user_id: 'member1',
    related_user_name: '田中',
    related_dm_ready: true,
    created: '2026-07-13 09:00',
    resolved: null,
  },
  {
    escalation_id: '2',
    reason: 'member_anomaly',
    // 折りたたみ(80文字超)の確認用
    context: `長い状況説明。${'あ'.repeat(100)}`,
    status: 'open',
    resolution: null,
    resolution_type: null,
    knowledge_reflected: false,
    related_user_id: null,
    related_user_name: null,
    related_dm_ready: false,
    created: '2026-07-12 18:00',
    resolved: null,
  },
  {
    escalation_id: '6',
    reason: 'priority_conflict',
    context: '対象メンバーの DM が未登録のケース',
    status: 'open',
    resolution: null,
    resolution_type: null,
    knowledge_reflected: false,
    related_user_id: 'member2',
    related_user_name: '佐藤',
    related_dm_ready: false,
    created: '2026-07-12 19:00',
    resolved: null,
  },
];

const resolvedRows = [
  {
    escalation_id: '3',
    reason: 'customer_impact',
    context: '解決済みの状況',
    status: 'resolved',
    resolution: '裁定の内容',
    resolution_type: 'ruling',
    knowledge_reflected: false, // 還流未了 → 再試行可能
    related_user_id: 'member1',
    related_user_name: '田中',
    related_dm_ready: true,
    created: '2026-07-10 09:00',
    resolved: '2026-07-10 12:00',
  },
  {
    escalation_id: '4',
    reason: 'priority_conflict',
    context: '回答送信で解決した状況',
    status: 'resolved',
    resolution: '回答の内容',
    resolution_type: 'admin_message', // 裁定以外 → 再試行対象外
    knowledge_reflected: false,
    related_user_id: 'member1',
    related_user_name: '田中',
    related_dm_ready: true,
    created: '2026-07-09 09:00',
    resolved: '2026-07-09 10:00',
  },
];

/** SQL とパラメータを捕捉するスタブプール(checkin.test.ts と同旨)。 */
function stubPool(
  captured: CapturedCall[] = [],
  behavior: { openRows?: unknown[]; resolvedRows?: unknown[]; actionRows?: unknown[] } = {},
): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      if (text.includes(`WHERE e.status = 'open'`)) {
        const rows = behavior.openRows ?? openRows;
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (text.includes(`WHERE e.status = 'resolved'`)) {
        const rows = behavior.resolvedRows ?? resolvedRows;
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      // POST の状態検証クエリ
      const rows = behavior.actionRows ?? [{ related_user_id: 'member1', related_dm_ready: true }];
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
    new Response(JSON.stringify({ job: 'escalation-action', sent: 1, skipped: 0, failed: 0 }), {
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

describe('エスカレーションページの描画', () => {
  it('未対応(古い順)と直近30日の解決済みを、理由ラベル・対象メンバー・状態バッジ付きで表示する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const captured: CapturedCall[] = [];
    const out = (await renderAdminEscalations(stubPool(captured), adminCtx())).html;

    assertCallsValid(captured);
    // 未対応は全件を古い順、解決済みは直近30日を新しい順
    expect(captured[0]?.text).toContain(`WHERE e.status = 'open'`);
    expect(captured[0]?.text).toContain('ORDER BY e.created_at');
    expect(captured[1]?.text).toContain(`e.resolved_at > now() - INTERVAL '30 days'`);
    expect(captured[1]?.text).toContain('ORDER BY e.resolved_at DESC');
    // 理由ラベルは shared の escalationReasonLabel を再利用
    expect(out).toContain('AIの確信度低');
    expect(out).toContain('メンバー異常シグナル');
    expect(out).toContain('顧客影響');
    expect(out).toContain('優先度の競合');
    // 対象メンバー名(ops.users JOIN)と状態バッジ
    expect(out).toContain('田中');
    expect(out).toContain('>未対応<');
    expect(out).toContain('>対応済み<');
    // 解決内容(resolution_type ラベル+resolution)
    expect(out).toContain('裁定(ナレッジ還流)');
    expect(out).toContain('メンバーへ回答');
    expect(out).toContain('裁定の内容');
    // 長文の状況は <details> で折りたたむ
    expect(out).toContain('<details class="fold">');
    // 全フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
  });

  it('未対応行の解決アクション(回答・裁定・回答不要)をアンカー付きカードで表示する(v0.12 §3)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminEscalations(stubPool(), adminCtx())).html;

    expect(out).toContain('id="escalation-1"');
    expect(out).toContain('value="answer"');
    expect(out).toContain('value="ruling"');
    expect(out).toContain('value="no_action"');
    expect(out).toContain('<textarea name="text"');
    // 裁定フォームの説明文(v0.12 §3)
    expect(out).toContain('判断基準ナレッジへ還流され、今後の回答に反映されます');
    // 全アクションに confirm 付き(誤クリック・二重送信の防止)
    expect(out).toContain('回答を送信し、このエスカレーションを解決しますか');
    expect(out).toContain('裁定を記録し、このエスカレーションを解決しますか');
    expect(out).toContain('回答不要として解決しますか');
  });

  it('related_user_id がない行・DM 未登録の行には回答フォームを出さず理由を表示する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminEscalations(stubPool(), adminCtx())).html;

    // #2(対象メンバーなし)のカードには回答フォームがなく、理由の案内が出る
    expect(out).toContain('回答の送信はできません');
    // #6(DM 未登録)のカードにも回答フォームがなく、登録手順の案内が出る
    expect(out).toContain('DM スペースが未登録のため回答を送信できません');
    expect(out).toContain('本人が Chat アプリに一度話しかけると登録されます');
    // 回答フォームは対象メンバーがいて DM 登録済みの #1 の1件のみ(裁定・回答不要は全カードに出る)
    expect(out.match(/value="answer"/g)).toHaveLength(1);
    expect(out.match(/value="ruling"/g)).toHaveLength(3);
  });

  it('還流未了の裁定(ruling / NULL)にのみ「ナレッジ還流を再試行」を表示する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminEscalations(stubPool(), adminCtx())).html;

    // #3(ruling・未還流)のみ。#4(admin_message)には出さない
    // (responsiveTable は PC 表とモバイルカードの2回描画するため、1行 = 2 箇所)
    expect(out.match(/value="reflux"/g)).toHaveLength(2);
    expect(out).toContain('name="escalation_id" value="3"');
    expect(out).not.toContain('name="escalation_id" value="4"');
    expect(out).toContain('ナレッジ還流を再試行');
  });

  it('BATCH_URL 未設定なら操作フォームを出さず案内を表示する(グレースフルデグラデーション)', async () => {
    const out = (await renderAdminEscalations(stubPool(), adminCtx())).html;
    expect(out).not.toContain('value="answer"');
    expect(out).not.toContain('value="reflux"');
    expect(out).toContain('BATCH_URL が未設定');
  });

  it('操作結果のフラッシュ(成功・失敗・エラー)を表示する', async () => {
    const answered = (
      await renderAdminEscalations(stubPool(), adminCtx('?answered=1&sent=1&skipped=0&failed=0'))
    ).html;
    expect(answered).toContain('メンバーへ回答を送信し、解決として記録しました');

    const ruled = (
      await renderAdminEscalations(stubPool(), adminCtx('?ruled=1&sent=1&skipped=0&failed=0'))
    ).html;
    expect(ruled).toContain('裁定を記録しました');

    // 裁定の還流失敗は sent=1, failed=1(batch との契約)。全面成功の文言を出さず
    // 「ナレッジ還流を再試行」への手動回復パスを案内する
    const rulingRefluxFailed = (
      await renderAdminEscalations(stubPool(), adminCtx('?ruled=1&sent=1&skipped=0&failed=1'))
    ).html;
    expect(rulingRefluxFailed).toContain('裁定は記録しましたが、ナレッジへの反映に失敗しました');
    expect(rulingRefluxFailed).toContain('ナレッジ還流を再試行');
    expect(rulingRefluxFailed).not.toContain('今後の回答に反映されます</div>');

    // 裁定以外の failed>0 は AIM-6009 の案内つきエラー表示
    const failed = (
      await renderAdminEscalations(stubPool(), adminCtx('?answered=1&sent=0&skipped=0&failed=1'))
    ).html;
    expect(failed).toContain('AIM-6009');

    // skipped の文言はアクションで出し分ける(解決系=別経路で解決済み/還流=還流済み)
    const skippedResolve = (
      await renderAdminEscalations(stubPool(), adminCtx('?no_action_done=1&sent=0&skipped=1&failed=0'))
    ).html;
    expect(skippedResolve).toContain('別の経路で既に解決済みのため、送信・記録は行いませんでした');
    const skippedReflux = (
      await renderAdminEscalations(stubPool(), adminCtx('?refluxed=1&sent=0&skipped=1&failed=0'))
    ).html;
    expect(skippedReflux).toContain('既にナレッジへ還流済みでした');

    const errored = (await renderAdminEscalations(stubPool(), adminCtx('?escalation_error=request')))
      .html;
    expect(errored).toContain('AIM-6009');
    expect(errored).toContain('起動または実行に失敗しました');

    // 継承プロパティ名はメッセージ扱いしない
    const ignored = (await renderAdminEscalations(stubPool(), adminCtx('?escalation_error=toString')))
      .html;
    expect(ignored).not.toContain('alert error');
  });
});

describe('エスカレーション操作ハンドラ(POST)', () => {
  it('BATCH_URL 未設定は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminEscalationsPost(
          stubPool(),
          viewer,
          new URLSearchParams({ action: 'ruling', escalation_id: '1', text: '裁定' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'BATCH_URL',
    );
  });

  it('answer: open を SoT で検証し、text と operatorUserId を含むボディで batch を起動して PRG する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const captured: CapturedCall[] = [];

    const location = await handleAdminEscalationsPost(
      stubPool(captured),
      viewer,
      new URLSearchParams({ action: 'answer', escalation_id: '5', text: '回答本文' }),
    );

    assertCallsValid(captured);
    // open 状態に加え、対象メンバーの DM 登録も SoT で検証する
    expect(captured[0]?.text).toContain(`status = 'open'`);
    expect(captured[0]?.text).toContain('chat_space_id');
    expect(captured[0]?.params).toEqual(['5']);
    expect(mocks.getIdTokenFor).toHaveBeenCalledWith('https://batch.example.run.app');
    expect(fetchCalls).toEqual([
      {
        url: 'https://batch.example.run.app/jobs/escalation-action',
        method: 'POST',
        auth: 'Bearer id-token',
        body: JSON.stringify({
          escalationId: '5',
          action: 'answer',
          text: '回答本文',
          operatorUserId: 'u1',
        }),
      },
    ]);
    // PRG: 解決したカードは消えるためアンカーなし(結果は sticky なフラッシュで見える)
    expect(location).toBe('/admin/escalations?answered=1&sent=1&skipped=0&failed=0');
  });

  it('ruling: 裁定テキスト付きで起動し ?ruled=1 へ PRG する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);

    const location = await handleAdminEscalationsPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'ruling', escalation_id: '1', text: '判断基準はこうする' }),
    );

    expect(fetchCalls[0]?.body).toBe(
      JSON.stringify({
        escalationId: '1',
        action: 'ruling',
        text: '判断基準はこうする',
        operatorUserId: 'u1',
      }),
    );
    expect(location).toBe('/admin/escalations?ruled=1&sent=1&skipped=0&failed=0');
  });

  it('no_action: text なしのボディで起動する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);

    const location = await handleAdminEscalationsPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'no_action', escalation_id: '2' }),
    );

    expect(fetchCalls[0]?.body).toBe(
      JSON.stringify({ escalationId: '2', action: 'no_action', operatorUserId: 'u1' }),
    );
    expect(location).toBe('/admin/escalations?no_action_done=1&sent=1&skipped=0&failed=0');
  });

  it('reflux: 還流可能(resolved・未還流・裁定)を SoT で検証してから起動する', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    const captured: CapturedCall[] = [];

    const location = await handleAdminEscalationsPost(
      stubPool(captured, { actionRows: [{}] }),
      viewer,
      new URLSearchParams({ action: 'reflux', escalation_id: '3' }),
    );

    expect(captured[0]?.text).toContain('NOT knowledge_reflected');
    expect(captured[0]?.text).toContain(`resolution_type = 'ruling' OR resolution_type IS NULL`);
    expect(fetchCalls[0]?.body).toBe(
      JSON.stringify({ escalationId: '3', action: 'reflux', operatorUserId: 'u1' }),
    );
    expect(location).toBe('/admin/escalations?refluxed=1&sent=1&skipped=0&failed=0#resolved');
  });

  it('answer / ruling は text 必須(未入力・1000字超は AIM-6004)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    for (const form of [
      new URLSearchParams({ action: 'answer', escalation_id: '1' }),
      new URLSearchParams({ action: 'ruling', escalation_id: '1', text: '' }),
      new URLSearchParams({ action: 'answer', escalation_id: '1', text: 'x'.repeat(1001) }),
    ]) {
      await expectAppErrorAsync(
        () => handleAdminEscalationsPost(stubPool(), viewer, form),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
      );
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('whitelist 外の action・不正な escalation_id は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    for (const form of [
      new URLSearchParams({ action: 'delete', escalation_id: '1' }),
      new URLSearchParams({ action: 'resolve', escalation_id: '1', text: 'x' }),
      new URLSearchParams({ action: 'no_action', escalation_id: 'abc' }),
    ]) {
      await expectAppErrorAsync(
        () => handleAdminEscalationsPost(stubPool(), viewer, form),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
      );
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('対象が open でない(解決競合)場合は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminEscalationsPost(
          stubPool([], { actionRows: [] }),
          viewer,
          new URLSearchParams({ action: 'no_action', escalation_id: '99' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('answer: 対象メンバーのいない行への回答送信は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminEscalationsPost(
          stubPool([], { actionRows: [{ related_user_id: null, related_dm_ready: false }] }),
          viewer,
          new URLSearchParams({ action: 'answer', escalation_id: '2', text: '回答' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '回答を送信できません',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('answer: 対象メンバーが DM 未登録の行への回答送信は AIM-6004(400)で batch を起動しない', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls = stubFetch(okResponse);
    await expectAppErrorAsync(
      () =>
        handleAdminEscalationsPost(
          stubPool([], { actionRows: [{ related_user_id: 'member2', related_dm_ready: false }] }),
          viewer,
          new URLSearchParams({ action: 'answer', escalation_id: '6', text: '回答' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'DM スペースが未登録',
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('起動失敗・タイムアウトは例外にせず escalation_error へ PRG する(再読み込みで再実行しない)', async () => {
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    stubFetch(() => Promise.reject(new Error('connect failed')));
    const location = await handleAdminEscalationsPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'no_action', escalation_id: '1' }),
    );
    expect(location).toBe('/admin/escalations?escalation_error=request');

    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    stubFetch(() => Promise.reject(timeoutError));
    const timedOut = await handleAdminEscalationsPost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'no_action', escalation_id: '1' }),
    );
    expect(timedOut).toBe('/admin/escalations?escalation_error=timeout');
  });
});
