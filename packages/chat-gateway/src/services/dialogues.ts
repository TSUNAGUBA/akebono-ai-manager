import { ADHOC_CHECKIN_MAX_TURNS, AppError, ERROR_CODES, query } from '@ai-manager/shared';
import type pg from 'pg';
import { formatOpenTasks, listOpenTasks } from './tasks.js';

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
 * 状況確認(adhoc_checkin・v0.5)は構造化された完了マーカーを持たない軽量対話のため、
 * ターン数上限(ADHOC_CHECKIN_MAX_TURNS = 初回問いかけ+3往復)未満の間だけ
 * 「返信待ち」として扱う(プロンプト側が2〜3往復での自然な締めを指示し、
 * 上限は無関係なメッセージを取り込み続けないための保険)。
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
         OR (dialogue_type = 'completion_review' AND review IS NULL)
         OR (dialogue_type = 'adhoc_checkin' AND jsonb_array_length(turns) < ${ADHOC_CHECKIN_MAX_TURNS}))
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
  dialogueType:
    | 'morning_checkin'
    | 'completion_review'
    | 'adhoc_qa'
    | 'task_instruction'
    | 'escalation'
    | 'adhoc_checkin';
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

/**
 * ユーザーの着手中タスクを対話コンテキスト用に取得する。
 * [ID:番号] 付きの整形は tasks.ts の共通ヘルパーを再利用する
 * (朝の対話での着手検知 started_task_id が ID を参照する)。
 */
export async function openTasksSummary(pool: pg.Pool, userId: string): Promise<string> {
  return formatOpenTasks(await listOpenTasks(pool, userId));
}
