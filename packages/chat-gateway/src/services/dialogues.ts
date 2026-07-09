import { AppError, ERROR_CODES, query } from '@ai-manager/shared';
import type pg from 'pg';

/** ops.dialogues.turns の1要素 */
export interface DialogueTurn {
  role: 'ai' | 'user';
  content: string;
  ts: string;
}

export interface DialogueRow {
  dialogue_id: string; // BIGINT は pg で文字列になる
  created_at: Date;
  user_id: string;
  dialogue_type: string;
  task_id: string | null;
  project_id: string | null;
  turns: DialogueTurn[];
  hypothesis: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
}

const DIALOGUE_COLUMNS =
  'dialogue_id, created_at, user_id, dialogue_type, task_id, project_id, turns, hypothesis, review';

/**
 * 当日(JST)の「未完了の対話」を探す。
 * 朝の問答は hypothesis 未確定、夕の振り返りは review 未確定のものが対象。
 */
export async function findOpenDialogue(
  pool: pg.Pool,
  userId: string,
  jstDate: string,
): Promise<DialogueRow | undefined> {
  const result = await query<DialogueRow>(
    pool,
    `SELECT ${DIALOGUE_COLUMNS}
     FROM ops.dialogues
     WHERE user_id = $1
       AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND ((dialogue_type = 'morning_checkin' AND hypothesis IS NULL)
         OR (dialogue_type = 'completion_review' AND review IS NULL))
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, jstDate],
  );
  return result.rows[0];
}

/** 当日(JST)の朝の対話(仮説確定済みを含む)を取得する。夕の振り返りの文脈に使う。 */
export async function findMorningDialogue(
  pool: pg.Pool,
  userId: string,
  jstDate: string,
): Promise<DialogueRow | undefined> {
  const result = await query<DialogueRow>(
    pool,
    `SELECT ${DIALOGUE_COLUMNS}
     FROM ops.dialogues
     WHERE user_id = $1
       AND dialogue_type = 'morning_checkin'
       AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, jstDate],
  );
  return result.rows[0];
}

export interface CreateDialogueInput {
  userId: string;
  dialogueType: 'morning_checkin' | 'completion_review' | 'adhoc_qa' | 'escalation';
  turns: DialogueTurn[];
  taskId?: string | null;
  projectId?: string | null;
  modelUsed?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export async function createDialogue(
  pool: pg.Pool,
  input: CreateDialogueInput,
): Promise<{ dialogueId: string; createdAt: Date }> {
  const result = await query<{ dialogue_id: string; created_at: Date }>(
    pool,
    `INSERT INTO ops.dialogues
       (user_id, dialogue_type, turns, task_id, project_id, model_used, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     RETURNING dialogue_id, created_at`,
    [
      input.userId,
      input.dialogueType,
      JSON.stringify(input.turns),
      input.taskId ?? null,
      input.projectId ?? null,
      input.modelUsed ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.costUsd ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // RETURNING 付き INSERT で行が返らないことはないが、型上の防御
    throw new Error('INSERT ops.dialogues が行を返しませんでした');
  }
  return { dialogueId: row.dialogue_id, createdAt: row.created_at };
}

export interface AppendTurnsUpdate {
  hypothesis?: Record<string, unknown>;
  review?: Record<string, unknown>;
  modelUsed?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * 対話にターンを追記し、確定した仮説・レビュー・トークン累計を更新する。
 * WHERE 句は dialogue_id のみ(IDENTITY で一意)。created_at を条件に含めると、
 * node-postgres の timestamptz 丸め(µs→ms)により等値比較が恒常的に不成立となり
 * 0行更新のサイレント障害になるため使用しない。
 */
export async function appendTurns(
  pool: pg.Pool,
  dialogue: Pick<DialogueRow, 'dialogue_id'>,
  newTurns: DialogueTurn[],
  update: AppendTurnsUpdate = {},
): Promise<void> {
  const result = await query(
    pool,
    `UPDATE ops.dialogues SET
       turns = turns || $2::jsonb,
       hypothesis = COALESCE($3::jsonb, hypothesis),
       review = COALESCE($4::jsonb, review),
       model_used = COALESCE($5, model_used),
       input_tokens = COALESCE(input_tokens, 0) + COALESCE($6, 0),
       output_tokens = COALESCE(output_tokens, 0) + COALESCE($7, 0),
       cost_usd = COALESCE(cost_usd, 0) + COALESCE($8, 0)
     WHERE dialogue_id = $1`,
    [
      dialogue.dialogue_id,
      JSON.stringify(newTurns),
      update.hypothesis === undefined ? null : JSON.stringify(update.hypothesis),
      update.review === undefined ? null : JSON.stringify(update.review),
      update.modelUsed ?? null,
      update.inputTokens ?? null,
      update.outputTokens ?? null,
      update.costUsd ?? null,
    ],
  );
  if (result.rowCount === 0) {
    // 0行更新は対話ログの欠落を意味するためサイレントにしない
    throw new AppError(ERROR_CODES.DB_QUERY_FAILED, '対話ターンの保存対象が見つかりませんでした', {
      details: { dialogueId: dialogue.dialogue_id },
    });
  }
}

export function nowTurn(role: 'ai' | 'user', content: string): DialogueTurn {
  return { role, content, ts: new Date().toISOString() };
}

/** ユーザーの着手中タスクを対話コンテキスト用に取得する。 */
export async function openTasksSummary(pool: pg.Pool, userId: string): Promise<string> {
  const result = await query<{ title: string; status: string; due_date: string | null; project_name: string | null }>(
    pool,
    `SELECT t.title, t.status, t.due_date::text AS due_date, p.name AS project_name
     FROM ops.tasks t
     LEFT JOIN ops.projects p ON p.project_id = t.project_id
     WHERE t.assignee_id = $1 AND t.status IN ('approved', 'in_progress', 'blocked')
     ORDER BY t.due_date NULLS LAST, t.task_id
     LIMIT 5`,
    [userId],
  );
  if (result.rows.length === 0) return '(登録済みの着手中タスクはありません)';
  return result.rows
    .map((t) => {
      const project = t.project_name === null ? '' : `[${t.project_name}] `;
      const due = t.due_date === null ? '' : `(期限: ${t.due_date})`;
      return `- ${project}${t.title} / 状態: ${t.status} ${due}`;
    })
    .join('\n');
}
