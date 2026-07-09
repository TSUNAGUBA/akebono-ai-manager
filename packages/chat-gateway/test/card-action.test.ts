import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsUser } from '../src/auth.js';
import type { ChatEvent } from '../src/chat-event.js';
import { handleCardAction } from '../src/handlers/card-action.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(async () => ({})),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, sendChatMessage: mocks.sendChatMessage, embedTexts: mocks.embedTexts };
});

beforeEach(() => {
  mocks.sendChatMessage.mockClear();
  mocks.sendChatMessage.mockResolvedValue({});
  mocks.embedTexts.mockClear();
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

function cardEvent(fn: string, params: Record<string, string>): ChatEvent {
  return {
    type: 'CARD_CLICKED',
    common: { invokedFunction: fn, parameters: params },
  };
}

const approvedTaskRow = {
  task_id: '7',
  project_id: 'p1',
  title: 'A社見積もり作成',
  description: '見積もりの作成',
  assignee_id: 'member1',
  requester_id: 'admin1',
  status: 'approved',
  ai_decomposition: { subtasks: [{ title: '要件整理' }], expected_outcome: '見積書完成' },
  due_date: '2026-07-17',
};

describe('decide_task(M3 承認カード)', () => {
  const approveResponder: Responder = (text) => {
    if (text.includes(`SET status = 'approved'`)) return { rows: [approvedTaskRow] };
    if (text.includes('display_name, chat_space_id')) {
      return { rows: [{ display_name: '田中', chat_space_id: 'spaces/member' }] };
    }
    if (text.includes('SELECT display_name FROM ops.users')) {
      return { rows: [{ display_name: '山下' }] };
    }
    return undefined;
  };

  it('承認: approved へ遷移し、担当メンバーへ DM 配信する', async () => {
    const { pool, calls } = createMockPool(approveResponder);
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'approve' }),
      admin,
    )) as { actionResponse?: { type: string }; cardsV2?: unknown[] };

    expect(result.actionResponse?.type).toBe('UPDATE_MESSAGE');
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '7',
      'proposed',
      'approved',
      'admin',
    ]);
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    const [space, message] = mocks.sendChatMessage.mock.calls[0] as unknown as [
      string,
      { text: string },
    ];
    expect(space).toBe('spaces/member');
    expect(message.text).toContain('A社見積もり作成');
    expect(message.text).toContain('期待成果');
    expect(JSON.stringify(result.cardsV2)).toContain('承認済み');
  });

  it('2度押し(既に承認済み)は現在状態の表示のみで、再配信しない(冪等)', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes(`SET status = 'approved'`)) return { rows: [] }; // 0行更新
      if (text.includes('FROM ops.tasks WHERE task_id')) return { rows: [approvedTaskRow] };
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'approve' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(result.cardsV2)).toContain('処理済み');
  });

  it('配信失敗でも承認は巻き戻さず、失敗を管理者に伝える(非ブロッキング)', async () => {
    mocks.sendChatMessage.mockRejectedValueOnce(new Error('chat down'));
    const { pool, calls } = createMockPool(approveResponder);
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'approve' }),
      admin,
    )) as { cardsV2?: unknown[] };

    const json = JSON.stringify(result.cardsV2);
    expect(json).toContain('承認済み');
    expect(json).toContain('配信に失敗');
    // 承認トランザクションは COMMIT 済みのまま(配信失敗による ROLLBACK なし)
    expect(callIndex(calls, 'COMMIT')).toBeGreaterThan(-1);
    expect(findCall(calls, 'ROLLBACK')).toBeUndefined();
  });

  it('却下の2度押しも現在状態の表示のみで、履歴を二重記録しない(冪等)', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'cancelled'`)) return { rows: [] }; // 0行更新
      if (text.includes('FROM ops.tasks WHERE task_id')) {
        return { rows: [{ ...approvedTaskRow, status: 'cancelled' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'reject' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'INSERT INTO ops.task_status_log')).toBeUndefined();
    expect(JSON.stringify(result.cardsV2)).toContain('処理済み');
  });

  it('却下: cancelled へ遷移し、出し直しを促す', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'cancelled'`)) {
        return { rows: [{ ...approvedTaskRow, status: 'cancelled' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'reject' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '7',
      'proposed',
      'cancelled',
      'admin',
    ]);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(result.cardsV2)).toContain('指示を出し直して');
  });

  it('管理者以外は操作できない', async () => {
    const { pool, calls } = createMockPool();
    const result = (await handleCardAction(
      pool,
      cardEvent('decide_task', { taskId: '7', decision: 'approve' }),
      member,
    )) as { text?: string };
    expect(result.text).toContain('管理者のみ');
    expect(calls).toHaveLength(0);
  });
});

describe('confirm_task_done(M3 完了確認カード)', () => {
  it('完了として記録: done へ遷移し履歴を残す', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'done'`)) {
        return { rows: [{ task_id: '3', title: 'A社の資料作成', status_from: 'in_progress' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('confirm_task_done', { taskId: '3', decision: 'done' }),
      member,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '3',
      'in_progress',
      'done',
      'dialogue',
    ]);
    expect(JSON.stringify(result.cardsV2)).toContain('完了として記録しました');
  });

  it('2度押し(既に done)は現在状態の表示のみ(巻き戻さない)', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'done'`)) return { rows: [] };
      if (text.includes('FROM ops.tasks WHERE task_id')) {
        return { rows: [{ ...approvedTaskRow, task_id: '3', status: 'done' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('confirm_task_done', { taskId: '3', decision: 'done' }),
      member,
    )) as { cardsV2?: unknown[] };
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')).toBeUndefined();
    expect(JSON.stringify(result.cardsV2)).toContain('完了');
  });

  it('本人のタスク以外は情報を表示しない', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes(`SET status = 'done'`)) return { rows: [] };
      if (text.includes('FROM ops.tasks WHERE task_id')) {
        return { rows: [{ ...approvedTaskRow, task_id: '3', assignee_id: 'someone-else' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('confirm_task_done', { taskId: '3', decision: 'done' }),
      member,
    )) as { text?: string };
    expect(result.text).toContain('見つかりませんでした');
  });

  it('記録しない: 状態を変更しない', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.tasks WHERE task_id')) {
        return { rows: [{ ...approvedTaskRow, task_id: '3', status: 'in_progress' }] };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('confirm_task_done', { taskId: '3', decision: 'dismiss' }),
      member,
    )) as { cardsV2?: unknown[] };
    expect(findCall(calls, `SET status = 'done'`)).toBeUndefined();
    expect(JSON.stringify(result.cardsV2)).toContain('記録しませんでした');
  });
});

describe('record_resolution(M6 裁定の記録)', () => {
  it('押下で「次のメッセージを裁定として記録」状態にする', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution_requested_by')) {
        return {
          rows: [
            {
              escalation_id: '5',
              reason: 'low_confidence',
              context: '質問: 種まきとは',
              status: 'open',
              resolution: null,
              knowledge_reflected: false,
            },
          ],
        };
      }
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('record_resolution', { escalationId: '5' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'SET resolution_requested_by')?.text).toContain(`status = 'open'`);
    expect(JSON.stringify(result.cardsV2)).toContain('次のメッセージを裁定として記録します');
  });

  it('裁定済みだが未還流の場合は再還流する(還流失敗の回復パス)', async () => {
    const resolved = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: '質問: 種まきとは',
      status: 'resolved',
      resolution: '在庫僅少時は出荷優先で裁定する',
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution_requested_by')) return { rows: [] };
      if (text.includes('FROM ops.escalations WHERE escalation_id')) return { rows: [resolved] };
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('record_resolution', { escalationId: '5' }),
      admin,
    )) as { cardsV2?: unknown[] };

    const chunkInsert = findCall(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(chunkInsert).toBeDefined();
    expect(chunkInsert?.text).toContain(`'decision_rules'`);
    expect(chunkInsert?.params[0]).toBe('escalation/5');
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeDefined();
    expect(JSON.stringify(result.cardsV2)).toContain('裁定済み');
  });

  it('再還流にも失敗したら「ナレッジ還流を再試行」ボタン付きカードを返す(復旧経路を維持)', async () => {
    mocks.embedTexts.mockRejectedValueOnce(new Error('embedding down'));
    const resolved = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: '質問: 種まきとは',
      status: 'resolved',
      resolution: '在庫僅少時は出荷優先で裁定する',
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution_requested_by')) return { rows: [] };
      if (text.includes('FROM ops.escalations WHERE escalation_id')) return { rows: [resolved] };
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('record_resolution', { escalationId: '5' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeUndefined();
    const json = JSON.stringify(result.cardsV2);
    expect(json).toContain('ナレッジ還流を再試行');
    expect(json).toContain('record_resolution'); // 再試行ボタンから同じ回復パスに到達できる
  });

  it('還流済みなら再試行ボタンを押しても再還流せず、裁定済みの表示のみ(冪等)', async () => {
    const reflected = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: '質問: 種まきとは',
      status: 'resolved',
      resolution: '在庫僅少時は出荷優先で裁定する',
      knowledge_reflected: true,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution_requested_by')) return { rows: [] };
      if (text.includes('FROM ops.escalations WHERE escalation_id')) return { rows: [reflected] };
      return undefined;
    });
    const result = (await handleCardAction(
      pool,
      cardEvent('record_resolution', { escalationId: '5' }),
      admin,
    )) as { cardsV2?: unknown[] };

    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeUndefined();
    expect(JSON.stringify(result.cardsV2)).toContain('裁定済み');
  });

  it('管理者以外は操作できない', async () => {
    const { pool, calls } = createMockPool();
    const result = (await handleCardAction(
      pool,
      cardEvent('record_resolution', { escalationId: '5' }),
      member,
    )) as { text?: string };
    expect(result.text).toContain('管理者のみ');
    expect(calls).toHaveLength(0);
  });
});
