import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMorningCheckin } from '../src/jobs/morning-checkin.js';
import { createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  sendChatMessage: vi.fn(async () => ({})),
  isJstWeekday: vi.fn(() => true),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateContent: mocks.generateContent,
    sendChatMessage: mocks.sendChatMessage,
    isJstWeekday: mocks.isJstWeekday,
  };
});

beforeEach(() => {
  mocks.generateContent.mockReset().mockResolvedValue({
    text: 'おはようございます。今日の3つの問いです。',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.001,
  });
  mocks.sendChatMessage.mockReset().mockResolvedValue({});
  mocks.isJstWeekday.mockReset().mockReturnValue(true);
  delete process.env['CALENDAR_ENABLED'];
});

const userWithDm = {
  user_id: 'member1',
  display_name: '田中',
  email: 'tanaka@example.com',
  chat_space_id: 'spaces/member1',
};
const userWithoutDm = {
  user_id: 'admin1',
  display_name: '山下',
  email: 'yamashita@example.com',
  chat_space_id: null,
};

/** 既定の responder: 問いかけ可のユーザー2名(DM あり/なし)、当日配信なし、タスクなし。 */
const baseResponder: Responder = (text) => {
  if (text.includes('FROM ops.users')) return { rows: [userWithDm, userWithoutDm] };
  if (text.includes(`dialogue_type = 'morning_checkin'`)) return { rows: [] };
  if (text.includes('INSERT INTO ops.dialogues')) return { rows: [{ dialogue_id: '41' }] };
  return { rows: [] };
};

describe('runMorningCheckin(朝の問いかけ配信)', () => {
  it('対象選定はロールではなく問いかけ可否フラグで行う(v0.8)', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    await runMorningCheckin(pool);

    const targetQuery = findCall(calls, 'FROM ops.users');
    expect(targetQuery?.text).toContain('active AND checkin_enabled');
    expect(targetQuery?.text).not.toContain(`role = 'member'`);
  });

  it('DM 登録済みへ配信し、未登録はスキップする(ロールに関わらず配信できる)', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runMorningCheckin(pool);

    expect(summary).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // SoT(対話レコード)への書込が配信より先(原則6)
    const insert = findCall(calls, 'INSERT INTO ops.dialogues');
    expect(insert?.text).toContain(`'morning_checkin'`);
    expect(insert?.params[0]).toBe('member1');
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    const [space] = mocks.sendChatMessage.mock.calls[0] as [string, { text: string }];
    expect(space).toBe('spaces/member1');
  });

  it('問いかけ可なら admin ロールのユーザーにも配信される(v0.8 受け入れ基準3)', async () => {
    const adminWithDm = { ...userWithoutDm, chat_space_id: 'spaces/admin1' };
    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.users')) return { rows: [adminWithDm] };
      if (text.includes(`dialogue_type = 'morning_checkin'`)) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) return { rows: [{ dialogue_id: '42' }] };
      return { rows: [] };
    });
    const summary = await runMorningCheckin(pool);
    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const [space] = mocks.sendChatMessage.mock.calls[0] as [string, { text: string }];
    expect(space).toBe('spaces/admin1');
  });

  it('当日分の対話が既にあるユーザーはスキップする(冪等)', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.users')) return { rows: [userWithDm] };
      if (text.includes(`dialogue_type = 'morning_checkin'`)) return { rows: [{ exists: 1 }] };
      return { rows: [] };
    });
    const summary = await runMorningCheckin(pool);
    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('休日は配信しない', async () => {
    mocks.isJstWeekday.mockReturnValue(false);
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runMorningCheckin(pool);
    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
