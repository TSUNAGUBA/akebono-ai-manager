import { query } from '@ai-manager/shared';
import type pg from 'pg';

export interface SuggestionRow {
  suggestion_id: string;
  content: string;
  user_decision: string | null;
  decision_reason: string | null;
}

export async function createSuggestion(
  pool: pg.Pool,
  input: {
    userId: string;
    content: string;
    category: 'next_action' | 'decomposition' | 'priority' | 'knowledge';
    dialogueId?: string;
    taskId?: string | null;
  },
): Promise<string> {
  const result = await query<{ suggestion_id: string }>(
    pool,
    `INSERT INTO ops.suggestions (dialogue_id, user_id, task_id, content, category)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING suggestion_id`,
    [input.dialogueId ?? null, input.userId, input.taskId ?? null, input.content, input.category],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('INSERT ops.suggestions が行を返しませんでした');
  return row.suggestion_id;
}

/**
 * 提案の採否を記録する。既に決定済みの場合は上書きしない(状態保護)。
 * @returns 更新できた場合は提案内容、決定済み・存在しない場合は undefined
 */
export async function decideSuggestion(
  pool: pg.Pool,
  suggestionId: string,
  userId: string,
  decision: 'accepted' | 'rejected',
): Promise<SuggestionRow | undefined> {
  const result = await query<SuggestionRow>(
    pool,
    `UPDATE ops.suggestions
     SET user_decision = $3, decided_at = now()
     WHERE suggestion_id = $1 AND user_id = $2 AND user_decision IS NULL
     RETURNING suggestion_id, content, user_decision, decision_reason`,
    [suggestionId, userId, decision],
  );
  return result.rows[0];
}

export async function getSuggestion(
  pool: pg.Pool,
  suggestionId: string,
  userId: string,
): Promise<SuggestionRow | undefined> {
  const result = await query<SuggestionRow>(
    pool,
    `SELECT suggestion_id, content, user_decision, decision_reason
     FROM ops.suggestions WHERE suggestion_id = $1 AND user_id = $2`,
    [suggestionId, userId],
  );
  return result.rows[0];
}

/**
 * 「理由待ち」の提案を探す: 直近15分以内に採否が決定され、まだ理由が無いもの。
 * 次のフリーテキスト返信を理由として記録するために使う。
 */
export async function findAwaitingReason(
  pool: pg.Pool,
  userId: string,
): Promise<SuggestionRow | undefined> {
  const result = await query<SuggestionRow>(
    pool,
    `SELECT suggestion_id, content, user_decision, decision_reason
     FROM ops.suggestions
     WHERE user_id = $1
       AND user_decision IS NOT NULL
       AND decision_reason IS NULL
       AND decided_at > now() - INTERVAL '15 minutes'
     ORDER BY decided_at DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0];
}

export async function attachReason(
  pool: pg.Pool,
  suggestionId: string,
  reason: string,
): Promise<void> {
  await query(
    pool,
    `UPDATE ops.suggestions SET decision_reason = $2
     WHERE suggestion_id = $1 AND decision_reason IS NULL`,
    [suggestionId, reason],
  );
}
