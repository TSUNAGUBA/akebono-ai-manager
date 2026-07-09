import { describe, expect, it } from 'vitest';
import {
  escalationCard,
  escalationReasonLabel,
  escalationRecordingCard,
  taskApprovalCard,
  taskDoneConfirmCard,
  taskStateCard,
} from '../src/chat-cards.js';

/** カード構造からボタンの action を平坦に取り出す。 */
function extractActions(card: unknown): Array<{ function: string; params: Record<string, string> }> {
  const actions: Array<{ function: string; params: Record<string, string> }> = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const action = (obj['onClick'] as Record<string, unknown> | undefined)?.['action'] as
      | { function?: string; parameters?: Array<{ key: string; value: string }> }
      | undefined;
    if (action?.function !== undefined) {
      const params: Record<string, string> = {};
      for (const p of action.parameters ?? []) params[p.key] = p.value;
      actions.push({ function: action.function, params });
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return actions;
}

describe('taskApprovalCard(M3 承認カード)', () => {
  const card = taskApprovalCard(7, {
    title: 'A社見積もり作成',
    assigneeName: '田中',
    dueDate: '2026-07-17',
    estimatedHours: 6,
    projectName: 'A社SI',
    subtasks: ['要件整理', '見積もり作成', 'レビュー依頼'],
    expectedOutcome: 'A社へ提出できる見積書が完成している',
  });

  it('承認して配信/却下の2ボタンが decide_task に taskId 付きで紐づく', () => {
    const actions = extractActions(card);
    expect(actions).toEqual([
      { function: 'decide_task', params: { taskId: '7', decision: 'approve' } },
      { function: 'decide_task', params: { taskId: '7', decision: 'reject' } },
    ]);
  });

  it('分解・担当案・期限案・期待成果と「却下して出し直す」運用の説明を含む', () => {
    const json = JSON.stringify(card);
    expect(json).toContain('田中');
    expect(json).toContain('2026-07-17');
    expect(json).toContain('要件整理');
    expect(json).toContain('期待成果');
    expect(json).toContain('却下」を押して、修正した指示を出し直して');
  });
});

describe('taskDoneConfirmCard / taskStateCard', () => {
  it('完了確認カードは confirm_task_done に done/dismiss を渡す', () => {
    const actions = extractActions(taskDoneConfirmCard('3', 'A社の資料作成'));
    expect(actions).toEqual([
      { function: 'confirm_task_done', params: { taskId: '3', decision: 'done' } },
      { function: 'confirm_task_done', params: { taskId: '3', decision: 'dismiss' } },
    ]);
  });

  it('状態カードはステータスを日本語ラベルで表示する', () => {
    expect(JSON.stringify(taskStateCard('X', 'approved'))).toContain('承認済み');
    expect(JSON.stringify(taskStateCard('X', 'done'))).toContain('完了');
    expect(JSON.stringify(taskStateCard('X', 'cancelled'))).toContain('却下');
  });
});

describe('escalationCard(M6 裁定の記録)', () => {
  it('「裁定を記録」ボタンが record_resolution に escalationId 付きで紐づく', () => {
    const actions = extractActions(escalationCard(5, 'low_confidence', '質問: 種まきとは'));
    expect(actions).toEqual([
      { function: 'record_resolution', params: { escalationId: '5' } },
    ]);
  });

  it('記録待ちカードは次メッセージを裁定として受け付ける旨を表示する(ボタンなし)', () => {
    const card = escalationRecordingCard(5, 'low_confidence', 'ctx');
    expect(extractActions(card)).toEqual([]);
    expect(JSON.stringify(card)).toContain('次のメッセージを裁定として記録します');
  });

  it('reason ラベルのマッピング', () => {
    expect(escalationReasonLabel('low_confidence')).toBe('AIの確信度低');
    expect(escalationReasonLabel('customer_impact')).toBe('顧客影響');
    expect(escalationReasonLabel('unknown_reason')).toBe('unknown_reason');
  });
});
