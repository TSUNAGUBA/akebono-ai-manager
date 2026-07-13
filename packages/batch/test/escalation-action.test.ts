import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESCALATION_ANSWER_PREFIX } from '@ai-manager/shared';
import { runEscalationAction } from '../src/jobs/escalation-action.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(async () => ({})),
  refluxResolutionToKnowledge: vi.fn(async () => undefined),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    sendChatMessage: mocks.sendChatMessage,
    refluxResolutionToKnowledge: mocks.refluxResolutionToKnowledge,
  };
});

beforeEach(() => {
  mocks.sendChatMessage.mockReset().mockResolvedValue({});
  mocks.refluxResolutionToKnowledge.mockReset().mockResolvedValue(undefined);
});

const openEscalation = {
  escalation_id: '9',
  reason: 'decision_needed',
  context: 'A社の値引き要求への対応',
  status: 'open',
  resolution: null,
  resolution_type: null,
  related_user_id: 'member1',
  knowledge_reflected: false,
};

/** 既定の responder: admin1 は active な管理者、エスカレーション #9 は open。 */
const makeResponder =
  (escalation: Record<string, unknown> = openEscalation): Responder =>
  (text, params) => {
    if (text.includes(`role = 'admin'`)) {
      return params[0] === 'admin1' ? { rows: [{ '?column?': 1 }] } : { rows: [] };
    }
    if (text.includes('FROM ops.escalations WHERE escalation_id')) return { rows: [escalation] };
    if (text.includes('SELECT chat_space_id FROM ops.users')) {
      return { rows: [{ chat_space_id: 'spaces/member1' }] };
    }
    if (text.includes('INSERT INTO ops.dialogues')) return { rows: [{ dialogue_id: '55' }] };
    if (text.includes('SET resolution = $3')) {
      // recordResolution の open 条件付き UPDATE(open のみヒットする)
      return escalation['status'] === 'open'
        ? { rows: [{ ...escalation, status: 'resolved', resolution: params[2], resolution_type: params[3] }] }
        : { rows: [] };
    }
    return { rows: [] };
  };

const answerParams = {
  escalationId: '9',
  action: 'answer',
  text: '値引きは10%まで対応可としてください。',
  operatorUserId: 'admin1',
};

describe('runEscalationAction: 共通検証', () => {
  it('escalationId / operatorUserId / action の欠落は AIM-5005(400)', async () => {
    const { pool } = createMockPool(makeResponder());
    for (const params of [
      { action: 'answer', operatorUserId: 'admin1' },
      { escalationId: '9', action: 'answer' },
      { escalationId: '9', operatorUserId: 'admin1' },
    ]) {
      await expect(runEscalationAction(pool, params)).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
    }
  });

  it('不明な action は AIM-5005(400)', async () => {
    const { pool } = createMockPool(makeResponder());
    await expect(
      runEscalationAction(pool, { ...answerParams, action: 'delete' }),
    ).rejects.toMatchObject({ code: 'AIM-5005', status: 400 });
  });

  it('operatorUserId が active な admin でない場合は AIM-5005(多層防御)', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    await expect(
      runEscalationAction(pool, { ...answerParams, operatorUserId: 'member1' }),
    ).rejects.toMatchObject({ code: 'AIM-5005', status: 400 });
    // 検証は active かつ admin ロールで行い、以降の処理へ進まない
    const adminCheck = findCall(calls, `role = 'admin'`);
    expect(adminCheck?.text).toContain('active');
    expect(findCall(calls, 'FROM ops.escalations')).toBeUndefined();
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('存在しないエスカレーションは AIM-5005', async () => {
    const { pool } = createMockPool((text, params) => {
      if (text.includes(`role = 'admin'`)) return { rows: [{ '?column?': 1 }] };
      if (text.includes('FROM ops.escalations')) return { rows: [] };
      return makeResponder()(text, params);
    });
    await expect(runEscalationAction(pool, answerParams)).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
  });
});

describe('runEscalationAction: answer(メンバーへ回答を送信して解決)', () => {
  it('SoT ファースト: 対話レコード作成 → DM 送信 → 送信成功後に admin_message で解決する', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runEscalationAction(pool, answerParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    // 対話は escalation として本人に記録され、文面の冒頭に管理者回答の明示が付く
    const insert = findCall(calls, 'INSERT INTO ops.dialogues');
    expect(insert?.text).toContain(`'escalation'`);
    expect(insert?.params[0]).toBe('member1');
    expect(String(insert?.params[1])).toContain(ESCALATION_ANSWER_PREFIX);
    const [space, message] = mocks.sendChatMessage.mock.calls[0] as [string, { text: string }];
    expect(space).toBe('spaces/member1');
    expect(message.text.startsWith(ESCALATION_ANSWER_PREFIX)).toBe(true);
    expect(message.text).toContain(answerParams.text);
    // 解決の記録(recordResolution)は対話レコード作成・送信より後(送達を確認してから解決)
    const resolve = findCall(calls, 'SET resolution = $3');
    expect(callIndex(calls, 'INSERT INTO ops.dialogues')).toBeLessThan(
      callIndex(calls, 'SET resolution = $3'),
    );
    expect(resolve?.params[2]).toBe(answerParams.text);
    expect(resolve?.params[3]).toBe('admin_message');
    expect(resolve?.params[1]).toBe('admin1'); // resolved_by は操作者
  });

  it('DM 送信失敗は対話レコードを補償削除し、解決を記録せず failed を返す(open のまま=再操作可能)', async () => {
    mocks.sendChatMessage.mockRejectedValue(new Error('chat down'));
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runEscalationAction(pool, answerParams);

    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(findCall(calls, 'DELETE FROM ops.dialogues')?.params).toEqual(['55']);
    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
  });

  it('text 欠落・1000字超過は AIM-5005', async () => {
    const { pool } = createMockPool(makeResponder());
    for (const text of [undefined, 'あ'.repeat(1001)]) {
      await expect(runEscalationAction(pool, { ...answerParams, text })).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
    }
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('対象メンバーのいないエスカレーションには回答を送信できない(AIM-5005)', async () => {
    const { pool } = createMockPool(makeResponder({ ...openEscalation, related_user_id: null }));
    await expect(runEscalationAction(pool, answerParams)).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('対象メンバーの DM スペース未登録は AIM-5005(送信しない)', async () => {
    const { pool } = createMockPool((text, params) => {
      if (text.includes('SELECT chat_space_id FROM ops.users')) {
        return { rows: [{ chat_space_id: null }] };
      }
      return makeResponder()(text, params);
    });
    await expect(runEscalationAction(pool, answerParams)).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('既に解決済みのエスカレーションへの再操作は DM を送らずスキップする(二重送信の防止 — 原則2)', async () => {
    const { pool, calls } = createMockPool(makeResponder({ ...openEscalation, status: 'resolved' }));
    const summary = await runEscalationAction(pool, answerParams);

    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(findCall(calls, 'INSERT INTO ops.dialogues')).toBeUndefined();
  });

  it('送信後に別経路で解決済みだった競合は警告してスキップ扱い(解決済みを上書きしない)', async () => {
    const { pool } = createMockPool((text, params) => {
      // getEscalation 時点では open、recordResolution 時点では競合(0行)
      if (text.includes('SET resolution = $3')) return { rows: [] };
      return makeResponder()(text, params);
    });
    const summary = await runEscalationAction(pool, answerParams);
    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });
});

describe('runEscalationAction: ruling(裁定の記録+ナレッジ還流)', () => {
  const rulingParams = { ...answerParams, action: 'ruling', text: '値引きは10%を上限とする。' };

  it('resolution_type=ruling で解決を記録し、ナレッジへ還流する', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runEscalationAction(pool, rulingParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const resolve = findCall(calls, 'SET resolution = $3');
    expect(resolve?.params[2]).toBe(rulingParams.text);
    expect(resolve?.params[3]).toBe('ruling');
    // 還流には更新後(裁定入り)の行を渡す
    expect(mocks.refluxResolutionToKnowledge).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ escalation_id: '9', resolution: rulingParams.text }),
    );
    // 裁定に DM 送信は伴わない
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('還流の失敗は非ブロッキング(裁定の記録は保持し sent 扱い。再還流で回復可能 — 原則4)', async () => {
    mocks.refluxResolutionToKnowledge.mockRejectedValue(new Error('embedding down'));
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runEscalationAction(pool, rulingParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'SET resolution = $3')).toBeDefined();
  });

  it('既に解決済みならスキップし、還流もしない(解決済みを上書きしない)', async () => {
    const { pool } = createMockPool(makeResponder({ ...openEscalation, status: 'resolved' }));
    const summary = await runEscalationAction(pool, rulingParams);

    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.refluxResolutionToKnowledge).not.toHaveBeenCalled();
  });
});

describe('runEscalationAction: no_action(回答不要として解決)', () => {
  it('text 省略時は既定メモで解決し、還流・DM は行わない', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runEscalationAction(pool, {
      escalationId: '9',
      action: 'no_action',
      operatorUserId: 'admin1',
    });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const resolve = findCall(calls, 'SET resolution = $3');
    expect(resolve?.params[2]).toBe('回答不要として解決');
    expect(resolve?.params[3]).toBe('no_action');
    expect(mocks.refluxResolutionToKnowledge).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('text 指定時はそのメモで解決する', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    await runEscalationAction(pool, {
      escalationId: '9',
      action: 'no_action',
      text: '既に口頭で回答済み',
      operatorUserId: 'admin1',
    });
    expect(findCall(calls, 'SET resolution = $3')?.params[2]).toBe('既に口頭で回答済み');
  });
});

describe('runEscalationAction: reflux(還流の再試行 — 手動回復パス)', () => {
  const refluxParams = { escalationId: '9', action: 'reflux', operatorUserId: 'admin1' };
  const resolvedUnreflected = {
    ...openEscalation,
    status: 'resolved',
    resolution: '値引きは10%を上限とする。',
    resolution_type: 'ruling',
    knowledge_reflected: false,
  };

  it('解決済み・未還流のエスカレーションを再還流する', async () => {
    const { pool } = createMockPool(makeResponder(resolvedUnreflected));
    const summary = await runEscalationAction(pool, refluxParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(mocks.refluxResolutionToKnowledge).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ escalation_id: '9' }),
    );
  });

  it('open のエスカレーションは再還流できない(AIM-5005)', async () => {
    const { pool } = createMockPool(makeResponder());
    await expect(runEscalationAction(pool, refluxParams)).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
    expect(mocks.refluxResolutionToKnowledge).not.toHaveBeenCalled();
  });

  it('裁定(ruling / 旧データの NULL)以外の解決は再還流できない(解決メモをナレッジ化しない)', async () => {
    for (const resolutionType of ['admin_message', 'no_action']) {
      const { pool } = createMockPool(
        makeResponder({ ...resolvedUnreflected, resolution_type: resolutionType }),
      );
      await expect(runEscalationAction(pool, refluxParams)).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
    }
    expect(mocks.refluxResolutionToKnowledge).not.toHaveBeenCalled();
    // v0.12 以前の未分類(NULL)は裁定として再還流できる(下位互換)
    const { pool } = createMockPool(makeResponder({ ...resolvedUnreflected, resolution_type: null }));
    await expect(runEscalationAction(pool, refluxParams)).resolves.toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('既に還流済みならスキップする(冪等)', async () => {
    const { pool } = createMockPool(
      makeResponder({ ...resolvedUnreflected, knowledge_reflected: true }),
    );
    const summary = await runEscalationAction(pool, refluxParams);
    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.refluxResolutionToKnowledge).not.toHaveBeenCalled();
  });

  it('明示的な再還流の失敗はジョブ失敗として返す(画面にエラー表示させる)', async () => {
    mocks.refluxResolutionToKnowledge.mockRejectedValue(new Error('embedding down'));
    const { pool } = createMockPool(makeResponder(resolvedUnreflected));
    await expect(runEscalationAction(pool, refluxParams)).rejects.toThrowError('embedding down');
  });
});
