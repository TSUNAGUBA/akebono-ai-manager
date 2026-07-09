import { logger, optionalEnv, query, sendChatMessage } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * エスカレーション(M6)。
 * 起票と管理者通知は補助処理のため、失敗しても主要フロー(対話応答)を止めない。
 */
export async function raiseEscalation(
  pool: pg.Pool,
  input: {
    reason: 'low_confidence' | 'customer_impact' | 'member_anomaly' | 'priority_conflict';
    context: string;
    relatedUserId?: string;
    relatedTaskId?: string | null;
  },
): Promise<void> {
  try {
    await query(
      pool,
      `INSERT INTO ops.escalations (reason, context, related_task_id, related_user_id)
       VALUES ($1, $2, $3, $4)`,
      [input.reason, input.context, input.relatedTaskId ?? null, input.relatedUserId ?? null],
    );
    const adminSpace = optionalEnv('ADMIN_SPACE_ID', '');
    if (adminSpace !== '') {
      await sendChatMessage(adminSpace, {
        text: `⚠️ エスカレーション(${input.reason})\n${input.context.slice(0, 500)}`,
      });
    }
  } catch (err) {
    logger.error('エスカレーションの起票・通知に失敗しました(処理は継続)', err);
  }
}
