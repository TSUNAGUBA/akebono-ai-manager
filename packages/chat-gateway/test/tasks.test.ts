import { describe, expect, it, vi } from 'vitest';
import {
  approveTask,
  buildTaskDeliveryText,
  completeTaskFromDialogue,
  createProposedTask,
  formatOpenTasks,
  validateDecomposition,
  type ActiveUserRow,
  type ProjectRow,
  type TaskRow,
} from '../src/services/tasks.js';
import { callIndex, createMockPool, findCall } from './mock-pool.js';

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, sendChatMessage: vi.fn(async () => ({})) };
});

const users: ActiveUserRow[] = [
  { user_id: 'admin1', display_name: '山下', role: 'admin' },
  { user_id: 'member1', display_name: '田中', role: 'member' },
];
const projects: ProjectRow[] = [{ project_id: 'p1', name: 'A社SI' }];

describe('validateDecomposition(分解レスポンスの検証)', () => {
  const base = {
    task_title: 'A社見積もり作成',
    description: '見積もりを作成する',
    expected_outcome: '提出可能な見積書',
    subtasks: [{ title: '要件整理', estimated_hours: 2 }, { title: '' }, { title: '作成' }],
    estimated_hours: 6,
    suggested_deadline: '2026-07-17',
    suggested_assignee_id: 'member1',
    project_id: 'p1',
  };

  it('正常系: 空サブタスクを除去して正規化する', () => {
    const result = validateDecomposition(base, users, projects);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigneeId).toBe('member1');
    expect(result.value.dueDate).toBe('2026-07-17');
    expect(result.value.projectId).toBe('p1');
    expect(result.value.subtasks.map((s) => s.title)).toEqual(['要件整理', '作成']);
  });

  it('担当者が active 一覧に実在しなければ確定しない(推測で INSERT しない)', () => {
    const result = validateDecomposition(
      { ...base, suggested_assignee_id: 'ghost' },
      users,
      projects,
    );
    expect(result.ok).toBe(false);
  });

  it('題名が空なら確定しない', () => {
    expect(validateDecomposition({ ...base, task_title: ' ' }, users, projects).ok).toBe(false);
  });

  it('期限・プロジェクトが不正でも失敗にせず未設定へ落とす', () => {
    const result = validateDecomposition(
      { ...base, suggested_deadline: '来週金曜', project_id: 'nonexistent' },
      users,
      projects,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dueDate).toBeNull();
    expect(result.value.projectId).toBeNull();
  });

  it('形式は正しいが実在しない期限日は null に落とす(起票クラッシュ防止)', () => {
    for (const invalid of ['2026-06-31', '2026-13-01', '2026-02-29', '2026-00-10']) {
      const result = validateDecomposition({ ...base, suggested_deadline: invalid }, users, projects);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.dueDate).toBeNull();
    }
    // 実在する閏日は有効なまま
    const leap = validateDecomposition({ ...base, suggested_deadline: '2028-02-29' }, users, projects);
    expect(leap.ok).toBe(true);
    if (!leap.ok) return;
    expect(leap.value.dueDate).toBe('2028-02-29');
  });
});

describe('createProposedTask(proposed 登録+履歴)', () => {
  const decomposition = {
    title: 'A社見積もり作成',
    description: null,
    expectedOutcome: '提出可能な見積書',
    subtasks: [{ title: '要件整理' }],
    estimatedHours: 6,
    dueDate: '2026-07-17',
    assigneeId: 'member1',
    projectId: 'p1',
  };

  it('ops.tasks への INSERT と task_status_log を同一トランザクションで記録する', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.tasks')) return { rows: [{ task_id: '7' }] };
      return undefined;
    });
    const taskId = await createProposedTask(pool, { requesterId: 'admin1', decomposition });
    expect(taskId).toBe('7');

    const insertTask = findCall(calls, 'INSERT INTO ops.tasks');
    expect(insertTask?.text).toContain(`'proposed'`);
    expect(insertTask?.params[4]).toBe('admin1'); // requester_id

    const log = findCall(calls, 'INSERT INTO ops.task_status_log');
    expect(log?.params).toEqual(['7', null, 'proposed', 'admin']);

    expect(callIndex(calls, 'BEGIN')).toBeLessThan(callIndex(calls, 'INSERT INTO ops.tasks'));
    expect(callIndex(calls, 'COMMIT')).toBeGreaterThan(
      callIndex(calls, 'INSERT INTO ops.task_status_log'),
    );
  });

  it('INSERT 失敗時は ROLLBACK して例外を伝播する', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.tasks')) return new Error('boom');
      return undefined;
    });
    await expect(
      createProposedTask(pool, { requesterId: 'admin1', decomposition }),
    ).rejects.toThrow();
    expect(findCall(calls, 'ROLLBACK')).toBeDefined();
    expect(findCall(calls, 'COMMIT')).toBeUndefined();
  });
});

describe('approveTask / completeTaskFromDialogue(状態遷移の冪等性)', () => {
  it('proposed のみ承認でき、遷移時に履歴を記録する', async () => {
    const row: TaskRow = {
      task_id: '7',
      project_id: 'p1',
      title: 'A社見積もり作成',
      description: null,
      assignee_id: 'member1',
      requester_id: 'admin1',
      status: 'approved',
      ai_decomposition: null,
      due_date: '2026-07-17',
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'approved'`)) return { rows: [row] };
      return undefined;
    });
    const approved = await approveTask(pool, '7', 'admin1');
    expect(approved?.status).toBe('approved');
    expect(findCall(calls, `SET status = 'approved'`)?.text).toContain(`status = 'proposed'`);
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '7',
      'proposed',
      'approved',
      'admin',
    ]);
  });

  it('既に決定済み(0行更新)なら undefined を返し、履歴を記録しない', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    const approved = await approveTask(pool, '7', 'admin1');
    expect(approved).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')).toBeUndefined();
  });

  it('完了記録は本人の未完了タスクのみ対象で、遷移元ステータスを履歴に残す', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes(`SET status = 'done'`)) {
        return { rows: [{ task_id: '3', title: 'A社の資料作成', status_from: 'in_progress' }] };
      }
      return undefined;
    });
    const done = await completeTaskFromDialogue(pool, '3', 'member1');
    expect(done?.title).toBe('A社の資料作成');
    const update = findCall(calls, `SET status = 'done'`);
    expect(update?.text).toContain('assignee_id = $2');
    expect(update?.params).toEqual(['3', 'member1']);
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '3',
      'in_progress',
      'done',
      'dialogue',
    ]);
  });
});

describe('配信文面・タスク一覧整形', () => {
  it('配信文面にタスク内容・分解案・期待成果・期限を含める', () => {
    const task: TaskRow = {
      task_id: '7',
      project_id: 'p1',
      title: 'A社見積もり作成',
      description: 'A社向けの初回見積もりを作成する',
      assignee_id: 'member1',
      requester_id: 'admin1',
      status: 'approved',
      ai_decomposition: {
        subtasks: [{ title: '要件整理' }, { title: '見積もり作成' }],
        expected_outcome: 'A社へ提出できる見積書が完成している',
      },
      due_date: '2026-07-17',
    };
    const text = buildTaskDeliveryText(task, '山下');
    expect(text).toContain('A社見積もり作成');
    expect(text).toContain('山下さんからの依頼です');
    expect(text).toContain('1. 要件整理');
    expect(text).toContain('期待成果');
    expect(text).toContain('期限: 2026-07-17');
  });

  it('タスク一覧は [ID:番号] 付きで整形する(朝の対話の着手検知が参照)', () => {
    const formatted = formatOpenTasks([
      { task_id: '3', title: 'A社の資料作成', status: 'approved', due_date: '2026-07-17', project_name: 'A社SI' },
    ]);
    expect(formatted).toContain('[ID:3]');
    expect(formatted).toContain('A社の資料作成');
    expect(formatOpenTasks([])).toContain('着手中タスクはありません');
  });
});
