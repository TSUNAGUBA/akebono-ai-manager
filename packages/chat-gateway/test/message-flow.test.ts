import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsUser } from '../src/auth.js';
import type { ChatEvent } from '../src/chat-event.js';
import { handleMessage } from '../src/handlers/message.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateJson: vi.fn(),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  sendChatMessage: vi.fn(async () => ({})),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateJson: mocks.generateJson,
    embedTexts: mocks.embedTexts,
    sendChatMessage: mocks.sendChatMessage,
  };
});

beforeEach(() => {
  mocks.generateJson.mockReset();
  mocks.embedTexts.mockClear();
  mocks.sendChatMessage.mockClear();
});

const admin: OpsUser = {
  user_id: 'admin1',
  display_name: '山下',
  email: 'admin@example.com',
  role: 'admin',
  chat_space_id: 'spaces/admin',
  active: true,
};
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

const llmResult = { model: 'test-model', inputTokens: 10, outputTokens: 20, costUsd: 0.001 };

describe('タスク指示の検知と分解(M3)', () => {
  const baseResponder: Responder = (text) => {
    if (text.includes('FROM ops.escalations')) return { rows: [] };
    if (text.includes('FROM ops.suggestions')) return { rows: [] };
    if (text.includes('FROM ops.users WHERE active')) {
      return {
        rows: [
          { user_id: 'admin1', display_name: '山下', role: 'admin' },
          { user_id: 'member1', display_name: '田中', role: 'member' },
        ],
      };
    }
    if (text.includes('FROM ops.projects')) return { rows: [{ project_id: 'p1', name: 'A社SI' }] };
    if (text.includes('INSERT INTO ops.tasks')) return { rows: [{ task_id: '7' }] };
    if (text.includes('INSERT INTO ops.dialogues')) {
      return { rows: [{ dialogue_id: '11', created_at: new Date() }] };
    }
    return { rows: [] };
  };

  it('管理者の「タスク:」指示を分解し、proposed 登録+承認カードを返す', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        task_title: 'A社見積もり作成',
        description: 'A社向けの見積もりを作成する',
        expected_outcome: '提出可能な見積書',
        subtasks: [{ title: '要件整理' }, { title: '見積もり作成' }],
        estimated_hours: 6,
        suggested_deadline: '2026-07-17',
        suggested_assignee_id: 'member1',
        project_id: 'p1',
      },
      result: llmResult,
    });

    const { pool, calls } = createMockPool(baseResponder);
    const response = await handleMessage(
      pool,
      messageEvent('タスク: A社の見積もり作成を田中さんにお願いしたい'),
      admin,
    );

    // pro ティアで分解が呼ばれる
    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { tier: string; system: string };
    expect(genCall.tier).toBe('pro');
    expect(genCall.system).toContain('member1'); // active メンバー一覧を供給
    expect(genCall.system).toContain('p1'); // プロジェクト一覧を供給

    // proposed で INSERT + 履歴記録
    const insertTask = findCall(calls, 'INSERT INTO ops.tasks');
    expect(insertTask?.text).toContain(`'proposed'`);
    expect(insertTask?.params[4]).toBe('admin1'); // requester_id = 管理者
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '7',
      null,
      'proposed',
      'admin',
    ]);
    // 対話ログ(task_instruction)
    expect(findCall(calls, 'INSERT INTO ops.dialogues')?.params).toContain('task_instruction');

    // 承認カード
    const json = JSON.stringify(response.cardsV2);
    expect(json).toContain('decide_task');
    expect(json).toContain('田中');
  });

  it('担当者を特定できない分解結果はタスク登録せず、出し直しを促す', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        task_title: 'A社見積もり作成',
        expected_outcome: '見積書',
        subtasks: [],
        suggested_deadline: '2026-07-17',
        suggested_assignee_id: 'ghost-user',
      },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(baseResponder);
    const response = await handleMessage(pool, messageEvent('タスク: A社の見積もり作成'), admin);

    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(response.text).toContain('出し直して');
  });

  it('メンバーのメッセージはタスク指示として扱わない(QA へ)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '回答です', confidence: 'high' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '12', created_at: new Date() }] };
      }
      return { rows: [] };
    });
    await handleMessage(pool, messageEvent('タスク: これはメンバーの発言'), member);
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    // QA(adhoc_qa)として記録される
    expect(findCall(calls, 'INSERT INTO ops.dialogues')?.params).toContain('adhoc_qa');
  });
});

describe('完了申告からの進捗更新(M3)', () => {
  it('完了申告時、未完了タスクと高確度で照合できたら完了確認カードを付ける', async () => {
    // 1回目: 夕の振り返り応答 / 2回目: タスク照合
    mocks.generateJson
      .mockResolvedValueOnce({
        value: { reply: 'おつかれさまです。差分はどうでしたか?', review_complete: false },
        result: llmResult,
      })
      .mockResolvedValueOnce({
        value: { matched: true, task_id: '3', confidence: 'high' },
        result: llmResult,
      });

    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '13', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('FROM ops.tasks t')) {
        return {
          rows: [
            {
              task_id: '3',
              title: 'A社の資料作成',
              status: 'in_progress',
              due_date: null,
              project_name: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('A社の資料作成、終わりました'), member);
    const json = JSON.stringify(response.cardsV2 ?? []);
    expect(json).toContain('confirm_task_done');
    expect(json).toContain('A社の資料作成');
  });

  it('照合に失敗しても夕の振り返り応答は返す(非ブロッキング)', async () => {
    mocks.generateJson
      .mockResolvedValueOnce({
        value: { reply: 'おつかれさまです。', review_complete: false },
        result: llmResult,
      })
      .mockRejectedValueOnce(new Error('llm down'));

    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '14', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('FROM ops.tasks t')) {
        return {
          rows: [
            { task_id: '3', title: 'A社の資料作成', status: 'in_progress', due_date: null, project_name: null },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('終わりました'), member);
    expect(response.text).toBe('おつかれさまです。');
    expect(response.cardsV2).toBeUndefined();
  });
});

describe('裁定の受領とナレッジ還流(M6)', () => {
  it('裁定待ちの管理者メッセージを resolution に保存し、decision_rules へ還流する', async () => {
    const awaiting = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: '質問: 在庫僅少時の優先順位',
      status: 'open',
      resolution: null,
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '出荷優先で裁定する' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('出荷優先で裁定する'), admin);

    // SoT(ops.escalations)への保存が先、キャッシュ(rag)への還流が後
    const sotIndex = callIndex(calls, 'SET resolution = $3');
    const cacheIndex = callIndex(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(sotIndex).toBeGreaterThan(-1);
    expect(cacheIndex).toBeGreaterThan(sotIndex);
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')?.params[0]).toBe('escalation/5');
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeDefined();
    expect(response.text).toContain('還流');
  });

  it('還流に失敗しても裁定の記録は保持し、再還流の方法を伝える', async () => {
    mocks.embedTexts.mockRejectedValueOnce(new Error('embedding down'));
    const awaiting = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: 'ctx',
      status: 'open',
      resolution: null,
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '裁定内容' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('裁定内容'), admin);
    expect(findCall(calls, 'SET resolution = $3')).toBeDefined();
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeUndefined();
    expect(response.text).toContain('裁定は記録しました');
  });
});
