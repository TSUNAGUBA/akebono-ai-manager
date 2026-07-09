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

  it('還流に失敗しても裁定の記録は保持し、「ナレッジ還流を再試行」ボタン付きカードを返す', async () => {
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
    // 復旧経路: 再試行ボタンから card-action の再還流分岐に到達できる
    const json = JSON.stringify(response.cardsV2);
    expect(json).toContain('ナレッジ還流を再試行');
    expect(json).toContain('record_resolution');
  });
});

describe('裁定ゲートの入力ガード(M6: 無条件キャプチャ防止)', () => {
  const awaiting = {
    escalation_id: '5',
    reason: 'low_confidence',
    context: '質問: 在庫僅少時の優先順位',
    status: 'open',
    resolution: null,
    knowledge_reflected: false,
  };
  const gateResponder: Responder = (text) => {
    if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
    return { rows: [] };
  };

  it('「キャンセル」で裁定の記録を中止し、受付状態(resolution_requested_*)をクリアする', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(pool, messageEvent('キャンセル'), admin);

    expect(findCall(calls, 'SET resolution_requested_by = NULL')).toBeDefined();
    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(response.text).toContain('中止');
  });

  it('疑問符で終わる質問は裁定として記録せず、案内を返す(ゲートは維持)', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('在庫の引き当てはどうなっていますか?'),
      admin,
    );

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'SET resolution_requested_by = NULL')).toBeUndefined();
    expect(response.text).toContain('裁定の記録待ち');
    expect(response.text).toContain('キャンセル');
  });

  it('タスク指示らしいメッセージは裁定として記録せず、タスク起票もしない', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('タスク: 田中さんに棚卸しの確認をお願い'),
      admin,
    );

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(mocks.generateJson).not.toHaveBeenCalled();
    expect(response.text).toContain('裁定の記録待ち');
  });

  it('1000字を超えるメッセージは裁定として記録しない(ゲートは維持)', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(pool, messageEvent('あ'.repeat(1001)), admin);

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(response.text).toContain('1000');
    expect(response.text).toContain('キャンセル');
  });

  it('担当者への言及を含む正当な裁定は flash-lite 分類を経て記録できる(締め出さない)', async () => {
    // 曖昧なタスク指示シグナル(さんに+確認して)→ flash-lite が「タスク指示でない」と判定
    mocks.generateJson.mockResolvedValueOnce({
      value: { is_task_instruction: false },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '裁定' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('在庫僅少時は出荷を優先し、判断に迷う場合は佐藤さんに確認してください'),
      admin,
    );
    expect(findCall(calls, 'SET resolution = $3')).toBeDefined();
    expect(response.text).toContain('還流');
  });

  it('flash-lite がタスク指示と判定したメッセージは裁定として記録しない', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { is_task_instruction: true },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('佐藤さんに今週中に棚卸しの対応をやってもらってください'),
      admin,
    );
    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(response.text).toContain('裁定の記録待ち');
  });
});

describe('進行中対話の優先(M3: タスク指示検知による横取り防止)', () => {
  const openMorning = (userId: string): Record<string, unknown> => ({
    dialogue_id: '21',
    created_at: new Date(),
    user_id: userId,
    dialogue_type: 'morning_checkin',
    task_id: null,
    project_id: null,
    turns: [{ role: 'ai', content: '今日は何から始めますか?', ts: new Date().toISOString() }],
    hypothesis: null,
    review: null,
  });

  it('朝の対話が進行中なら、タスク指示らしいメッセージも対話の継続として扱う', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '把握しました。成功条件はどう考えますか?', hypothesis_complete: false },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.escalations')) return { rows: [] };
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('admin1')] };
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('タスク: 田中さんに今日中にA社の棚卸しをお願い'),
      admin,
    );

    // タスク起票ではなく朝の対話の継続として処理される
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(findCall(calls, 'UPDATE ops.dialogues')).toBeDefined();
    expect(response.text).toContain('成功条件');
  });

  it('朝の対話で started_task_id が [ID:7] 形式でも数値部分を抽出して着手更新する', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '着手ですね。', hypothesis_complete: false, started_task_id: '[ID:7]' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('member1')] };
      if (text.includes(`SET status = 'in_progress'`)) return { rows: [{ task_id: '7' }] };
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('今日はA社の棚卸しをやります'), member);
    const update = findCall(calls, `SET status = 'in_progress'`);
    expect(update?.params).toEqual(['7', 'member1']);
  });

  it('started_task_id から数値を抽出できなければ着手更新をスキップする(対話応答は返す)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '進めましょう。', hypothesis_complete: false, started_task_id: 'A社タスク' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('member1')] };
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('進めます'), member);
    expect(findCall(calls, `SET status = 'in_progress'`)).toBeUndefined();
    expect(response.text).toBe('進めましょう。');
  });
});
