import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CORRECTION_INSTRUCTION, feedbackCorrectionFallback } from '@ai-manager/shared';
import { runDialogueFeedback } from '../src/jobs/dialogue-feedback.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  sendChatMessage: vi.fn(async () => ({})),
  embedTexts: vi.fn(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateContent: mocks.generateContent,
    sendChatMessage: mocks.sendChatMessage,
    embedTexts: mocks.embedTexts,
  };
});

beforeEach(() => {
  mocks.generateContent.mockReset().mockResolvedValue({
    text: '先の回答に誤りがありました。正しくは5営業日です。',
    model: 'test-pro',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
  });
  mocks.sendChatMessage.mockReset().mockResolvedValue({});
  mocks.embedTexts.mockReset().mockResolvedValue([[0.1, 0.2, 0.3]]);
});

const originalTurns = [
  { role: 'user', content: 'B社への納期はどれくらいですか?', ts: '2026-07-10T00:00:00.000Z' },
  { role: 'ai', content: '3営業日です。', ts: '2026-07-10T00:00:05.000Z' },
];

const newParams = {
  dialogueId: '5',
  dialogueCreatedAt: '2026-07-10T00:00:00.000Z',
  feedback: '正しくは5営業日です。',
  operatorUserId: 'admin1',
};

const pendingRow = {
  feedback_id: '10',
  dialogue_id: '5',
  dialogue_created_at: '2026-07-10T00:00:00.000Z',
  user_id: 'member1',
  feedback: '正しくは5営業日です。',
  status: 'pending',
  knowledge_reflected: false,
};

/** 既定の responder: admin1 は管理者、対話 #5 と member1 の DM スペースが存在。 */
const makeResponder =
  (overrides: Partial<Record<'feedbackRow', Record<string, unknown> | null>> = {}): Responder =>
  (text, params) => {
    if (text.includes(`role = 'admin'`)) {
      return params[0] === 'admin1' ? { rows: [{ '?column?': 1 }] } : { rows: [] };
    }
    if (text.includes('SELECT user_id, turns FROM ops.dialogues')) {
      return { rows: [{ user_id: 'member1', turns: originalTurns }] };
    }
    if (text.includes('SELECT turns FROM ops.dialogues')) {
      return { rows: [{ turns: originalTurns }] };
    }
    if (text.includes('INSERT INTO ops.dialogue_feedback')) return { rows: [{ feedback_id: '10' }] };
    if (text.includes('FROM ops.dialogue_feedback WHERE feedback_id')) {
      const row = overrides.feedbackRow;
      if (row === null) return { rows: [] };
      return { rows: [row ?? pendingRow] };
    }
    if (text.includes('SELECT chat_space_id FROM ops.users')) {
      return { rows: [{ chat_space_id: 'spaces/member1' }] };
    }
    if (text.includes('INSERT INTO ops.dialogues')) return { rows: [{ dialogue_id: '88' }] };
    return { rows: [] };
  };

describe('runDialogueFeedback: 新規登録+配信(v0.12 §7)', () => {
  it('フィードバックを SoT へ登録 → 還流 → 訂正対話作成 → DM 送信 → delivered 記録の順で処理する', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runDialogueFeedback(pool, newParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    // SoT(ops.dialogue_feedback)への登録が最初(原則6)。user_id は対話の本人
    const insert = findCall(calls, 'INSERT INTO ops.dialogue_feedback');
    expect(insert?.params).toEqual(['5', newParams.dialogueCreatedAt, 'member1', newParams.feedback, 'admin1']);
    // ナレッジ還流: doc_id=feedback/{id}・decision_rules・customer_id NULL の UPSERT
    const chunk = findCall(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(chunk?.text).toContain(`'decision_rules'`);
    expect(chunk?.text).toContain('ON CONFLICT (doc_id, chunk_index)');
    expect(chunk?.params[0]).toBe('feedback/10');
    // チャンクには元対話(質問と誤回答)とフィードバックの両方が入る
    expect(String(chunk?.params[2])).toContain('B社への納期');
    expect(String(chunk?.params[2])).toContain('正しくは5営業日です。');
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')?.params).toEqual(['10']);
    // 訂正対話(SoT)の作成が delivered 記録より先
    const dialogueInsert = findCall(calls, 'INSERT INTO ops.dialogues');
    expect(dialogueInsert?.text).toContain(`'feedback_correction'`);
    expect(dialogueInsert?.params[0]).toBe('member1');
    expect(callIndex(calls, 'INSERT INTO ops.dialogues')).toBeLessThan(
      callIndex(calls, `status = 'delivered'`),
    );
    // 送達の記録は pending 条件付き(冪等)で、訂正対話 ID を紐づける
    const delivered = findCall(calls, `status = 'delivered'`);
    expect(delivered?.text).toContain(`WHERE feedback_id = $1 AND status = 'pending'`);
    expect(delivered?.params).toEqual(['10', '88']);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('spaces/member1', {
      text: '先の回答に誤りがありました。正しくは5営業日です。',
    });
  });

  it('プロンプト供給: pro tier で訂正指示+元対話+フィードバックを渡す', async () => {
    const { pool } = createMockPool(makeResponder());
    await runDialogueFeedback(pool, newParams);

    const call = mocks.generateContent.mock.calls[0]?.[0] as { tier: string; system: string };
    expect(call.tier).toBe('pro');
    expect(call.system).toContain(FEEDBACK_CORRECTION_INSTRUCTION);
    expect(call.system).toContain('B社への納期はどれくらいですか?');
    expect(call.system).toContain('正しくは5営業日です。');
  });

  it('対話が存在しない場合は AIM-5005 で登録しない(パーティション表のため id+created_at で特定)', async () => {
    const { pool, calls } = createMockPool((text, params) => {
      if (text.includes('SELECT user_id, turns FROM ops.dialogues')) return { rows: [] };
      return makeResponder()(text, params);
    });
    await expect(runDialogueFeedback(pool, newParams)).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
    const lookup = findCall(calls, 'SELECT user_id, turns FROM ops.dialogues');
    expect(lookup?.text).toContain('dialogue_id = $1 AND created_at = $2');
    expect(findCall(calls, 'INSERT INTO ops.dialogue_feedback')).toBeUndefined();
  });

  it('operatorUserId が管理者でない・feedback が 2000 字超過・日時が不正なら AIM-5005', async () => {
    const { pool } = createMockPool(makeResponder());
    for (const params of [
      { ...newParams, operatorUserId: 'member1' },
      { ...newParams, feedback: 'あ'.repeat(2001) },
      { ...newParams, dialogueCreatedAt: 'not-a-date' },
    ]) {
      await expect(runDialogueFeedback(pool, params)).rejects.toMatchObject({
        code: 'AIM-5005',
        status: 400,
      });
    }
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('LLM 失敗時は定型文フォールバックで配信を続行する(原則4)', async () => {
    mocks.generateContent.mockRejectedValue(new Error('llm down'));
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runDialogueFeedback(pool, newParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const expected = feedbackCorrectionFallback(newParams.feedback);
    expect(mocks.sendChatMessage).toHaveBeenCalledWith('spaces/member1', { text: expected });
    expect(String(findCall(calls, 'INSERT INTO ops.dialogues')?.params[1])).toContain(
      newParams.feedback,
    );
  });

  it('DM 送信失敗は訂正対話を補償削除し、pending のまま failed を返す(再送で回復可能)', async () => {
    mocks.sendChatMessage.mockRejectedValue(new Error('chat down'));
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runDialogueFeedback(pool, newParams);

    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(findCall(calls, 'DELETE FROM ops.dialogues')?.params).toEqual(['88']);
    // status は pending のまま(delivered 更新なし)= 再送の対象として残る
    expect(findCall(calls, `status = 'delivered'`)).toBeUndefined();
  });

  it('還流失敗は非ブロッキングで配信を続行する(knowledge_reflected は false のまま=再送時に再試行)', async () => {
    mocks.embedTexts.mockRejectedValue(new Error('embedding down'));
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runDialogueFeedback(pool, newParams);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeUndefined();
    expect(findCall(calls, `status = 'delivered'`)).toBeDefined();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('DM スペース未登録は failed(pending のまま。還流は先に実施済みでも配信はしない)', async () => {
    const { pool, calls } = createMockPool((text, params) => {
      if (text.includes('SELECT chat_space_id FROM ops.users')) return { rows: [{ chat_space_id: null }] };
      return makeResponder()(text, params);
    });
    const summary = await runDialogueFeedback(pool, newParams);

    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(findCall(calls, `status = 'delivered'`)).toBeUndefined();
  });
});

describe('runDialogueFeedback: 再送(feedbackId 指定)', () => {
  it('pending の既存フィードバックを再送する(還流済みなら還流はスキップ)', async () => {
    const { pool, calls } = createMockPool(
      makeResponder({ feedbackRow: { ...pendingRow, knowledge_reflected: true } }),
    );
    const summary = await runDialogueFeedback(pool, { feedbackId: '10' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    // 新規登録は行わない(SoT の既存行を使う)
    expect(findCall(calls, 'INSERT INTO ops.dialogue_feedback')).toBeUndefined();
    // 還流済みのため embedding・UPSERT は再実行しない(冪等・コスト最小化)
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeUndefined();
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(findCall(calls, `status = 'delivered'`)?.params).toEqual(['10', '88']);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('未還流の pending 再送では還流を再試行する(手動回復パス)', async () => {
    const { pool, calls } = createMockPool(makeResponder());
    const summary = await runDialogueFeedback(pool, { feedbackId: '10' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')?.params[0]).toBe('feedback/10');
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeDefined();
  });

  it('delivered 済みのフィードバックは再送を拒否する(二重配信の防止 — AIM-5005)', async () => {
    const { pool } = createMockPool(
      makeResponder({ feedbackRow: { ...pendingRow, status: 'delivered' } }),
    );
    await expect(runDialogueFeedback(pool, { feedbackId: '10' })).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it('存在しない feedbackId は AIM-5005', async () => {
    const { pool } = createMockPool(makeResponder({ feedbackRow: null }));
    await expect(runDialogueFeedback(pool, { feedbackId: '999' })).rejects.toMatchObject({
      code: 'AIM-5005',
      status: 400,
    });
  });

  it('再送と新規登録のパラメータは併用できない(取り違え防止 — AIM-5005)', async () => {
    const { pool } = createMockPool(makeResponder());
    await expect(
      runDialogueFeedback(pool, { feedbackId: '10', dialogueId: '5' }),
    ).rejects.toMatchObject({ code: 'AIM-5005', status: 400 });
  });

  it('元対話を取得できなくても再送自体は継続する(訂正の送達を優先 — 原則4)', async () => {
    const { pool } = createMockPool((text, params) => {
      if (text.includes('SELECT turns FROM ops.dialogues')) return { rows: [] };
      return makeResponder({ feedbackRow: { ...pendingRow, knowledge_reflected: true } })(text, params);
    });
    const summary = await runDialogueFeedback(pool, { feedbackId: '10' });

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const call = mocks.generateContent.mock.calls[0]?.[0] as { system: string };
    expect(call.system).toContain('元対話のログを取得できませんでした');
  });
});
