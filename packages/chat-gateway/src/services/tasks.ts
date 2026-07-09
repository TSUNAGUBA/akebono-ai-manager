import { logger, query, sendChatMessage, withClient } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * タスクオーケストレーション(M3)。
 * SoT: ops.tasks(状態)+ ops.task_status_log(遷移履歴。dwh.fact_task_activity の源泉)。
 * 状態遷移は必ず task_status_log と同一トランザクションで記録する。
 */

export interface ActiveUserRow {
  user_id: string;
  display_name: string;
  role: 'admin' | 'member';
}

export interface ProjectRow {
  project_id: string;
  name: string;
}

export interface TaskRow {
  task_id: string; // BIGINT は pg で文字列になる
  project_id: string | null;
  title: string;
  description: string | null;
  assignee_id: string | null;
  requester_id: string | null;
  status: string;
  ai_decomposition: Record<string, unknown> | null;
  due_date: string | null;
}

const TASK_COLUMNS =
  'task_id, project_id, title, description, assignee_id, requester_id, status, ai_decomposition, due_date::text AS due_date';

export async function listActiveUsers(pool: pg.Pool): Promise<ActiveUserRow[]> {
  const result = await query<ActiveUserRow>(
    pool,
    `SELECT user_id, display_name, role FROM ops.users WHERE active ORDER BY user_id`,
  );
  return result.rows;
}

export async function listActiveProjects(pool: pg.Pool): Promise<ProjectRow[]> {
  const result = await query<ProjectRow>(
    pool,
    `SELECT project_id, name FROM ops.projects WHERE status = 'active' ORDER BY priority NULLS LAST, project_id`,
  );
  return result.rows;
}

export async function getTask(pool: pg.Pool, taskId: string): Promise<TaskRow | undefined> {
  const result = await query<TaskRow>(
    pool,
    `SELECT ${TASK_COLUMNS} FROM ops.tasks WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0];
}

export interface OpenTaskRow {
  task_id: string;
  title: string;
  status: string;
  due_date: string | null;
  project_name: string | null;
}

/** 本人の未完了タスク(approved / in_progress / blocked)を取得する。 */
export async function listOpenTasks(pool: pg.Pool, userId: string): Promise<OpenTaskRow[]> {
  const result = await query<OpenTaskRow>(
    pool,
    `SELECT t.task_id, t.title, t.status, t.due_date::text AS due_date, p.name AS project_name
     FROM ops.tasks t
     LEFT JOIN ops.projects p ON p.project_id = t.project_id
     WHERE t.assignee_id = $1 AND t.status IN ('approved', 'in_progress', 'blocked')
     ORDER BY t.due_date NULLS LAST, t.task_id
     LIMIT 10`,
    [userId],
  );
  return result.rows;
}

/** タスク一覧を [ID:番号] 付きでプロンプト供給用に整形する。 */
export function formatOpenTasks(tasks: OpenTaskRow[]): string {
  if (tasks.length === 0) return '(登録済みの着手中タスクはありません)';
  return tasks
    .map((t) => {
      const project = t.project_name === null ? '' : `[${t.project_name}] `;
      const due = t.due_date === null ? '' : `(期限: ${t.due_date})`;
      return `- [ID:${t.task_id}] ${project}${t.title} / 状態: ${t.status} ${due}`;
    })
    .join('\n');
}

// ── AI 分解結果の検証・正規化 ─────────────────────────────────────

/** LLM の分解レスポンス(TASK_DECOMPOSITION_SCHEMA に対応)。 */
export interface TaskDecompositionResponse {
  task_title?: string;
  description?: string;
  expected_outcome?: string;
  subtasks?: Array<{ title?: string; estimated_hours?: number }>;
  estimated_hours?: number;
  suggested_deadline?: string;
  suggested_assignee_id?: string;
  project_id?: string;
}

export interface ValidatedDecomposition {
  title: string;
  description: string | null;
  expectedOutcome: string | null;
  subtasks: Array<{ title: string; estimated_hours?: number }>;
  estimatedHours: number | null;
  dueDate: string | null;
  assigneeId: string;
  projectId: string | null;
}

export type DecompositionValidation =
  | { ok: true; value: ValidatedDecomposition }
  | { ok: false; reason: string };

/**
 * 'YYYY-MM-DD' 形式かつ実在する日付か。
 * Date での round-trip 検証により '2026-06-31' 等の繰り上がる日付を弾く
 * (そのまま INSERT すると DB の date 型でエラーになり起票がクラッシュする)。
 */
function isRealDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s;
}

/**
 * LLM の分解レスポンスを検証する。
 * 担当者はメンバー一覧に実在しなければ確定できない(推測で INSERT しない)。
 * 期限・プロジェクトは不正なら未設定に落とす(グレースフルデグラデーション)。
 */
export function validateDecomposition(
  value: TaskDecompositionResponse,
  users: ActiveUserRow[],
  projects: ProjectRow[],
): DecompositionValidation {
  const title = (value.task_title ?? '').trim();
  if (title === '') return { ok: false, reason: 'タスクの題名を特定できませんでした' };

  const assigneeId = (value.suggested_assignee_id ?? '').trim();
  if (assigneeId === '' || !users.some((u) => u.user_id === assigneeId)) {
    return { ok: false, reason: '担当者を特定できませんでした' };
  }

  const deadline = (value.suggested_deadline ?? '').trim();
  const dueDate = isRealDateString(deadline) ? deadline : null;

  const projectId = (value.project_id ?? '').trim();
  const validProjectId = projects.some((p) => p.project_id === projectId) ? projectId : null;

  const subtasks = (value.subtasks ?? [])
    .filter((s): s is { title: string; estimated_hours?: number } => (s.title ?? '').trim() !== '')
    .map((s) => ({
      title: s.title.trim(),
      ...(typeof s.estimated_hours === 'number' && s.estimated_hours > 0
        ? { estimated_hours: s.estimated_hours }
        : {}),
    }));

  const estimatedHours =
    typeof value.estimated_hours === 'number' && value.estimated_hours > 0
      ? value.estimated_hours
      : null;

  const description = (value.description ?? '').trim();
  const expectedOutcome = (value.expected_outcome ?? '').trim();

  return {
    ok: true,
    value: {
      title,
      description: description === '' ? null : description,
      expectedOutcome: expectedOutcome === '' ? null : expectedOutcome,
      subtasks,
      estimatedHours,
      dueDate,
      assigneeId,
      projectId: validProjectId,
    },
  };
}

// ── 状態遷移(SoT 書込 + 履歴記録を同一トランザクションで)──────────

async function insertStatusLog(
  client: pg.PoolClient,
  taskId: string,
  statusFrom: string | null,
  statusTo: string,
  changedVia: 'dialogue' | 'admin' | 'system',
): Promise<void> {
  await query(
    client,
    `INSERT INTO ops.task_status_log (task_id, status_from, status_to, changed_via)
     VALUES ($1, $2, $3, $4)`,
    [taskId, statusFrom, statusTo, changedVia],
  );
}

/** AI 分解結果を status='proposed' で登録し、履歴も記録する。 */
export async function createProposedTask(
  pool: pg.Pool,
  input: { requesterId: string; decomposition: ValidatedDecomposition },
): Promise<string> {
  const d = input.decomposition;
  const aiDecomposition = {
    subtasks: d.subtasks,
    estimated_hours: d.estimatedHours,
    suggested_deadline: d.dueDate,
    suggested_assignee_id: d.assigneeId,
    project_id: d.projectId,
    expected_outcome: d.expectedOutcome,
  };
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await query<{ task_id: string }>(
        client,
        `INSERT INTO ops.tasks
           (project_id, title, description, assignee_id, requester_id, status, ai_decomposition, due_date)
         VALUES ($1, $2, $3, $4, $5, 'proposed', $6::jsonb, $7)
         RETURNING task_id`,
        [
          d.projectId,
          d.title,
          d.description,
          d.assigneeId,
          input.requesterId,
          JSON.stringify(aiDecomposition),
          d.dueDate,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('INSERT ops.tasks が行を返しませんでした');
      await insertStatusLog(client, row.task_id, null, 'proposed', 'admin');
      await client.query('COMMIT');
      return row.task_id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * 承認: proposed → approved。
 * WHERE で status='proposed' を条件にするため冪等(2度押しで巻き戻らない)。
 * @returns 遷移できた場合はタスク行、既に決定済み・存在しない場合は undefined
 */
export async function approveTask(
  pool: pg.Pool,
  taskId: string,
  adminUserId: string,
): Promise<TaskRow | undefined> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await query<TaskRow>(
        client,
        `UPDATE ops.tasks
         SET status = 'approved', approved_by = $2, updated_at = now()
         WHERE task_id = $1 AND status = 'proposed'
         RETURNING ${TASK_COLUMNS}`,
        [taskId, adminUserId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await insertStatusLog(client, taskId, 'proposed', 'approved', 'admin');
      }
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** 却下: proposed → cancelled(修正指示は却下して出し直す運用)。冪等。 */
export async function cancelTask(pool: pg.Pool, taskId: string): Promise<TaskRow | undefined> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await query<TaskRow>(
        client,
        `UPDATE ops.tasks
         SET status = 'cancelled', updated_at = now()
         WHERE task_id = $1 AND status = 'proposed'
         RETURNING ${TASK_COLUMNS}`,
        [taskId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await insertStatusLog(client, taskId, 'proposed', 'cancelled', 'admin');
      }
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** 朝の対話での着手言及: approved → in_progress(本人のタスクのみ)。冪等。 */
export async function startTaskFromDialogue(
  pool: pg.Pool,
  taskId: string,
  userId: string,
): Promise<TaskRow | undefined> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await query<TaskRow>(
        client,
        `UPDATE ops.tasks
         SET status = 'in_progress', updated_at = now()
         WHERE task_id = $1 AND assignee_id = $2 AND status = 'approved'
         RETURNING ${TASK_COLUMNS}`,
        [taskId, userId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await insertStatusLog(client, taskId, 'approved', 'in_progress', 'dialogue');
      }
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** 完了確認カードでの記録: approved/in_progress/blocked → done(本人のタスクのみ)。冪等。 */
export async function completeTaskFromDialogue(
  pool: pg.Pool,
  taskId: string,
  userId: string,
): Promise<TaskRow | undefined> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await query<TaskRow & { status_from: string }>(
        client,
        `WITH prev AS (
           SELECT task_id, status FROM ops.tasks
           WHERE task_id = $1 AND assignee_id = $2
             AND status IN ('approved', 'in_progress', 'blocked')
           FOR UPDATE
         )
         UPDATE ops.tasks t
         SET status = 'done', completed_at = now(), updated_at = now()
         FROM prev
         WHERE t.task_id = prev.task_id
         RETURNING t.task_id, t.project_id, t.title, t.description, t.assignee_id,
                   t.requester_id, t.status, t.ai_decomposition,
                   t.due_date::text AS due_date, prev.status AS status_from`,
        [taskId, userId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await insertStatusLog(client, taskId, row.status_from, 'done', 'dialogue');
      }
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ── メンバーへの配信(M3: 承認 → DM 配信)──────────────────────────

interface DecompositionJson {
  subtasks?: Array<{ title?: string; estimated_hours?: number }>;
  expected_outcome?: string | null;
}

/** 配信文面: タスク内容+期待成果を含める。 */
export function buildTaskDeliveryText(task: TaskRow, requesterName: string): string {
  const d = (task.ai_decomposition ?? {}) as DecompositionJson;
  const lines = [`【新しいタスク】${task.title}`, `${requesterName}さんからの依頼です。`];
  if (task.description !== null && task.description !== '') {
    lines.push('', '■ 内容', task.description);
  }
  const subtasks = (d.subtasks ?? []).filter((s) => (s.title ?? '') !== '');
  if (subtasks.length > 0) {
    lines.push('', '■ 進め方の分解案', ...subtasks.map((s, i) => `${i + 1}. ${s.title ?? ''}`));
  }
  if (d.expected_outcome !== undefined && d.expected_outcome !== null && d.expected_outcome !== '') {
    lines.push('', '■ 期待成果', d.expected_outcome);
  }
  if (task.due_date !== null) {
    lines.push('', `期限: ${task.due_date}`);
  }
  lines.push(
    '',
    '着手するときは朝の問いかけで教えてください。終わったら「終わりました」と報告してもらえれば記録します。',
  );
  return lines.join('\n');
}

/**
 * 承認済みタスクを担当メンバーへ DM 配信する(補助処理)。
 * 失敗しても承認自体は巻き戻さず、管理者へ伝える文言を返す。
 * @returns 管理者向けの配信結果メモ(成功時も失敗時も返す)
 */
export async function deliverTaskToAssignee(
  pool: pg.Pool,
  task: TaskRow,
  requesterName: string,
): Promise<{ delivered: boolean; note: string }> {
  if (task.assignee_id === null) {
    return { delivered: false, note: '担当者が未設定のため配信できませんでした。' };
  }
  const result = await query<{ display_name: string; chat_space_id: string | null }>(
    pool,
    `SELECT display_name, chat_space_id FROM ops.users WHERE user_id = $1 AND active`,
    [task.assignee_id],
  );
  const assignee = result.rows[0];
  if (assignee === undefined) {
    return { delivered: false, note: '担当者が見つからないため配信できませんでした。' };
  }
  if (assignee.chat_space_id === null) {
    return {
      delivered: false,
      note: `${assignee.display_name}さんの DM スペースが未登録のため配信できませんでした(本人が Chat アプリに一度話しかけると登録されます)。`,
    };
  }
  try {
    await sendChatMessage(assignee.chat_space_id, {
      text: buildTaskDeliveryText(task, requesterName),
    });
    return { delivered: true, note: `${assignee.display_name}さんへ配信しました。` };
  } catch (err) {
    logger.error('タスクの DM 配信に失敗しました(承認は維持)', err, {
      taskId: task.task_id,
      assigneeId: task.assignee_id,
    });
    return {
      delivered: false,
      note: `${assignee.display_name}さんへの配信に失敗しました。時間をおいて本人に直接共有してください。`,
    };
  }
}
