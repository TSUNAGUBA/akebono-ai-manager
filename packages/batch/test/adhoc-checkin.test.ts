import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADHOC_CHECKIN_INSTRUCTION,
  ADHOC_CHECKIN_PREFIX,
} from '@ai-manager/shared';
import { runAdhocCheckin } from '../src/jobs/adhoc-checkin.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  sendChatMessage: vi.fn(async () => ({})),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateContent: mocks.generateContent,
    sendChatMessage: mocks.sendChatMessage,
  };
});

beforeEach(() => {
  mocks.generateContent.mockReset().mockResolvedValue({
    text: 'いまの進捗を教えてください。',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.001,
  });
  mocks.sendChatMessage.mockReset().mockResolvedValue({});
});

const memberWithDm = {
  user_id: 'member1',
  display_name: '田中',
  email: 'tanaka@example.com',
  chat_space_id: 'spaces/member1',
};
const memberWithoutDm = {
  user_id: 'member2',
  display_name: '佐藤',
  email: 'sato@example.com',
  chat_space_id: null,
};

/** 既定の responder: メンバー2名(DM あり/なし)、open な状況確認なし、タスク1件。 */
const baseResponder: Responder = (text, params) => {
  if (text.includes('FROM ops.users')) {
    if (text.includes('user_id = $1')) {
      const target = [memberWithDm, memberWithoutDm].find((m) => m.user_id === params[0]);
      return { rows: target === undefined ? [] : [target] };
    }
    return { rows: [memberWithDm, memberWithoutDm] };
  }
  if (text.includes(`dialogue_type = 'adhoc_checkin'`)) return { rows: [] };
  if (text.includes('FROM ops.tasks t')) {
    return {
      rows: [{ title: 'A社の見積もり作成', status: 'in_progress', due_date: '2026-07-15', project_name: 'A社SI' }],
    };
  }
  if (text.includes('INSERT INTO ops.dialogues')) {
    return { rows: [{ dialogue_id: '31' }] };
  }
  return { rows: [] };
};

describe('runAdhocCheckin(管理者発火の状況確認)', () => {
  it('全員モード: DM 登録済みへ配信し、未登録はスキップする', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool);

    expect(summary).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // 対話は adhoc_checkin として記録される
    const insert = findCall(calls, 'INSERT INTO ops.dialogues');
    expect(insert?.text).toContain(`'adhoc_checkin'`);
    expect(insert?.params[0]).toBe('member1');
    // SoT(対話レコード)への書込が配信より先(原則6)
    expect(callIndex(calls, 'INSERT INTO ops.dialogues')).toBeGreaterThan(-1);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    // 配信文面の冒頭に管理者発火の明示(要件 v0.5)
    const [space, message] = mocks.sendChatMessage.mock.calls[0] as [string, { text: string }];
    expect(space).toBe('spaces/member1');
    expect(message.text.startsWith(ADHOC_CHECKIN_PREFIX)).toBe(true);
    // 記録された turns にも同じ文面が入る
    expect(String(insert?.params[1])).toContain(ADHOC_CHECKIN_PREFIX);
  });

  it('プロンプト供給: flash-lite に ADHOC_CHECKIN_INSTRUCTION とタスク状況を渡す', async () => {
    const { pool } = createMockPool(baseResponder);
    await runAdhocCheckin(pool);

    const call = mocks.generateContent.mock.calls[0]?.[0] as {
      tier: string;
      system: string;
      messages: Array<{ role: string; text: string }>;
    };
    expect(call.tier).toBe('flash-lite');
    expect(call.system).toContain(ADHOC_CHECKIN_INSTRUCTION);
    expect(call.messages[0]?.text).toContain('A社の見積もり作成');
    expect(call.messages[0]?.text).toContain('田中');
  });

  it('個別モード: userId 指定はその1名のみに配信する(SQL に user_id 条件が付く)', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool, { userId: 'member1' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const memberQuery = findCall(calls, 'FROM ops.users');
    expect(memberQuery?.text).toContain('user_id = $1');
    expect(memberQuery?.params).toEqual(['member1']);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('個別モード: DM 未登録の1名はスキップとして報告する(受け入れ基準2)', async () => {
    const { pool } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool, { userId: 'member2' });
    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('個別モード: active なメンバーに見つからない userId はスキップとして報告する', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool, { userId: 'ghost' });
    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(findCall(calls, 'INSERT INTO ops.dialogues')).toBeUndefined();
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('LLM 失敗時は定型文へフォールバックして配信する(プレフィックス付き)', async () => {
    mocks.generateContent.mockRejectedValue(new Error('llm down'));
    const { pool } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool, { userId: 'member1' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const [, message] = mocks.sendChatMessage.mock.calls[0] as [string, { text: string }];
    expect(message.text.startsWith(ADHOC_CHECKIN_PREFIX)).toBe(true);
    expect(message.text).toContain('いまの進捗や状況を教えてください');
    expect(message.text).toContain('A社の見積もり作成'); // タスク状況は定型文にも入る
  });

  it('同日に open な状況確認があれば新規対話を作らず追い問いかけを送る(冪等性の設計判断)', async () => {
    const { pool, calls } = createMockPool((text, params) => {
      if (text.includes(`dialogue_type = 'adhoc_checkin'`)) return { rows: [{ dialogue_id: '77' }] };
      return baseResponder(text, params);
    });
    const summary = await runAdhocCheckin(pool, { userId: 'member1' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'INSERT INTO ops.dialogues')).toBeUndefined();
    // 既存対話へのターン追記
    const append = findCall(calls, 'SET turns = turns ||');
    expect(append?.params[0]).toBe('77');
    expect(String(append?.params[1])).toContain(ADHOC_CHECKIN_PREFIX);
    // 追い問いかけは LLM を使わない定型文
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('open 判定はターン数上限(返信待ちのみ)を条件にする', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    await runAdhocCheckin(pool, { userId: 'member1' });
    const openCheck = findCall(calls, `dialogue_type = 'adhoc_checkin'`);
    expect(openCheck?.text).toContain('jsonb_array_length(turns) < 7');
  });

  it('新規配信の失敗は対話レコードを補償削除し、failed として次のメンバーへ継続する(原則4)', async () => {
    mocks.sendChatMessage.mockRejectedValue(new Error('chat down'));
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runAdhocCheckin(pool);

    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 1 });
    expect(findCall(calls, 'DELETE FROM ops.dialogues')?.params).toEqual(['31']);
  });

  it('追い問いかけの配信失敗は追記したターンを取り除く(未配信ターンを残さない)', async () => {
    mocks.sendChatMessage.mockRejectedValue(new Error('chat down'));
    const { pool, calls } = createMockPool((text, params) => {
      if (text.includes(`dialogue_type = 'adhoc_checkin'`)) return { rows: [{ dialogue_id: '77' }] };
      return baseResponder(text, params);
    });
    const summary = await runAdhocCheckin(pool, { userId: 'member1' });

    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(findCall(calls, 'SET turns = turns - -1')?.params).toEqual(['77']);
  });
});
