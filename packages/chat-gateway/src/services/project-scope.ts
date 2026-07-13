import { logger, query } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * 質問の文脈から対象プロジェクトを特定する(要件 v0.10 §4.2)。
 * 優先順は対象顧客の特定(knowledge-scope.ts / v0.7 §4)と同じ:
 * ①質問文中のプロジェクト名/ID のマスタ照合(明示的な言及を最優先・最長一致)
 * ②対話文脈のプロジェクト(本人の直近 in_progress タスクのプロジェクト。呼び出し元が渡す)。
 * 照合の堅牢化も同じルール: LIKE メタ文字のエスケープ+2文字以上のみ照合。
 * 補助的な特定手段のため、失敗しても QA を止めない(開発原則 4)。
 *
 * 顧客の特定(identifyTargetCustomer)とは独立に動く: 「A社SI の目的は?」なら
 * プロジェクト文脈が、「A社の取引先は?」なら顧客マスタ情報が、それぞれ供給される
 * (両方に言及があれば両方供給される — 混同しない、が欠落もさせない)。
 */
export async function identifyTargetProject(
  pool: pg.Pool,
  text: string,
  contextProjectId?: string | null,
): Promise<string | undefined> {
  try {
    const result = await query<{ project_id: string; match_text: string }>(
      pool,
      `WITH candidates AS (
         SELECT project_id, name AS match_text FROM ops.projects WHERE length(name) >= 2
         UNION ALL
         SELECT project_id, project_id AS match_text FROM ops.projects WHERE length(project_id) >= 2
       ),
       escaped AS (
         SELECT project_id, match_text,
                replace(replace(replace(match_text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') AS pattern
           FROM candidates
       )
       SELECT project_id, match_text FROM escaped
        WHERE $1 ILIKE '%' || pattern || '%'
        ORDER BY length(match_text) DESC
        LIMIT 1`,
      [text],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      logger.debug('質問文から対象プロジェクトを特定しました', {
        projectId: row.project_id,
        matchedText: row.match_text,
      });
      return row.project_id;
    }
  } catch (err) {
    logger.error('プロジェクト名のマスタ照合に失敗しました(対話文脈のプロジェクトで継続)', err);
  }
  if (contextProjectId !== undefined && contextProjectId !== null && contextProjectId !== '') {
    return contextProjectId;
  }
  return undefined;
}
