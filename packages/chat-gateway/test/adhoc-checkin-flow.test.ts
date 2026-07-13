import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADHOC_CHECKIN_DIALOGUE_INSTRUCTION, ADHOC_CHECKIN_MAX_TURNS } from '@ai-manager/shared';
import type { OpsUser } from '../src/auth.js';
import type { ChatEvent } from '../src/chat-event.js';
import { handleMessage } from '../src/handlers/message.js';
import { createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  generateJson: vi.fn(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateContent: mocks.generateContent,
    generateJson: mocks.generateJson,
  };
});

beforeEach(() => {
  mocks.generateContent.mockReset().mockResolvedValue({
    text: 'なるほど、順調そうですね。詰まっている点はありますか?',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.001,
  });
  mocks.generateJson.mockReset();
});

const member: OpsUser = {
  user_id: 'member1',
  display_name: '田中',
  email: 'member@example.com',
  role: 'member',
  chat_space_id: 'spaces/member',
  active: true,
};

function messageEvent(text: string): ChatEvent {
  return { type: 'MESSAGE', message: { text, argumentText: text } };
}

const openAdhoc = {
  dialogue_id: '55',
  created_at: new Date(),
  user_id: 'member1',
  dialogue_type: 'adhoc_checkin',
  task_id: null,
  project_id: null,
  turns: [
    { role: 'ai', content: '(管理者からの状況確認です)\nいまの進捗を教えてください。', ts: new Date().toISOString() },
  ],
  hypothesis: null,
  review: null,
};

const responder: Responder = (text) => {
  if (text.includes('FROM ops.suggestions')) return { rows: [] };
  if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
  if (text.includes('FROM ops.dialogues')) return { rows: [openAdhoc] };
  if (text.includes('FROM ops.tasks t')) {
    return {
      rows: [
        { task_id: '3', title: 'A社の資料作成', status: 'in_progress', due_date: null, project_name: null },
      ],
    };
  }
  return { rows: [] };
};

describe('状況確認(adhoc_checkin)への返信の継続(v0.5)', () => {
  it('open な状況確認への返信は軽量な継続として turns へ追記される', async () => {
    const { pool, calls } = createMockPool(responder);
    const response = await handleMessage(pool, messageEvent('A社の資料は半分まで進みました'), member);

    // flash のプレーンテキスト生成(仮説形成の構造化出力は使わない)
    expect(mocks.generateJson).not.toHaveBeenCalled();
    const gen = mocks.generateContent.mock.calls[0]?.[0] as { tier: string; system: string };
    expect(gen.tier).toBe('flash');
    expect(gen.system).toContain(ADHOC_CHECKIN_DIALOGUE_INSTRUCTION);
    expect(gen.system).toContain('A社の資料作成'); // 本人のタスク状況を文脈供給

    // 返信+AI 応答が同じ対話へ追記される(全件構造化保存)
    const update = findCall(calls, 'UPDATE ops.dialogues');
    expect(update).toBeDefined();
    expect(update?.params[0]).toBe('55');
    expect(String(update?.params[1])).toContain('A社の資料は半分まで進みました');
    expect(response.text).toContain('詰まっている点はありますか');
  });

  it('findOpenDialogue は adhoc_checkin をターン数上限つきで返信待ちとして拾う', async () => {
    const { pool, calls } = createMockPool(responder);
    await handleMessage(pool, messageEvent('進んでいます'), member);

    const openQuery = findCall(calls, 'FROM ops.dialogues');
    expect(openQuery?.text).toContain(`dialogue_type = 'adhoc_checkin'`);
    expect(openQuery?.text).toContain(`jsonb_array_length(turns) < ${ADHOC_CHECKIN_MAX_TURNS}`);
    // 既存の朝夕の open 条件は変えない(回帰確認)
    expect(openQuery?.text).toContain(`dialogue_type = 'morning_checkin' AND hypothesis IS NULL`);
    expect(openQuery?.text).toContain(`dialogue_type = 'completion_review' AND review IS NULL`);
  });

  it('継続はタスク起票・QA に横取りされない', async () => {
    const { pool, calls } = createMockPool(responder);
    await handleMessage(pool, messageEvent('タスク: これは対話の途中の発言'), member);

    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.dialogues')).toBeUndefined(); // 新規対話(QA)を作らない
    expect(findCall(calls, 'UPDATE ops.dialogues')).toBeDefined();
  });

  it('応答生成が失敗しても返信ターンを保存し、フォールバック文言で応答する(v0.9 §5)', async () => {
    mocks.generateContent.mockRejectedValueOnce(new Error('llm down'));
    const { pool, calls } = createMockPool(responder);

    const response = await handleMessage(pool, messageEvent('進捗は半分です'), member);

    // 汎用エラー(処理中にエラーが発生しました)にせず、返信を記録した上で定型文を返す
    expect(response.text).toContain('一時的に失敗');
    expect(response.text).toContain('記録しています');
    const update = findCall(calls, 'UPDATE ops.dialogues');
    expect(update?.params[0]).toBe('55');
    expect(String(update?.params[1])).toContain('進捗は半分です'); // 返信は失われない
  });
});
