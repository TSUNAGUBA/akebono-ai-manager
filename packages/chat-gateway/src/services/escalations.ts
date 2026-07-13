import {
  ESCALATION_COLUMNS,
  escalationCard,
  escalationReasonLabel,
  logger,
  optionalEnv,
  query,
  sendChatMessage,
  type EscalationRow,
} from '@ai-manager/shared';
import type pg from 'pg';

/**
 * エスカレーション(M6)の Chat 側フロー(起票通知・裁定の受付ゲート)。
 * 解決の保存(recordResolution)とナレッジ還流(refluxResolutionToKnowledge)は
 * ダッシュボードの解決アクション(batch の escalation-action ジョブ — v0.12 §3)と
 * 共用するため shared/escalations.ts に定義し、ここから再エクスポートする(開発原則 3)。
 *
 * SoT: ops.escalations(裁定 resolution を含む)。
 * rag.knowledge_chunks の doc_id='escalation/{id}' チャンクは SoT からの還流キャッシュ。
 */
export {
  getEscalation,
  recordResolution,
  refluxResolutionToKnowledge,
  type EscalationRow,
} from '@ai-manager/shared';

/**
 * 起票と管理者通知。補助処理のため、失敗しても主要フロー(対話応答)を止めない。
 * 通知は「裁定を記録」ボタン付きカードで送る(裁定のナレッジ還流の入口)。
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
    const inserted = await query<{ escalation_id: string }>(
      pool,
      `INSERT INTO ops.escalations (reason, context, related_task_id, related_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING escalation_id`,
      [input.reason, input.context, input.relatedTaskId ?? null, input.relatedUserId ?? null],
    );
    const escalationId = inserted.rows[0]?.escalation_id;
    const adminSpace = optionalEnv('ADMIN_SPACE_ID', '');
    if (adminSpace !== '' && escalationId !== undefined) {
      await sendChatMessage(adminSpace, {
        text: `⚠️ エスカレーション(${escalationReasonLabel(input.reason)})`,
        cardsV2: [escalationCard(escalationId, input.reason, input.context)],
      });
    }
  } catch (err) {
    logger.error('エスカレーションの起票・通知に失敗しました(処理は継続)', err);
  }
}

/**
 * 「裁定を記録」ボタン押下: 次のメッセージを裁定として受け付ける状態にする。
 * open のもののみ対象(裁定済みを巻き戻さない)。再押下は受付時刻の更新のみで冪等。
 */
export async function requestResolutionRecording(
  pool: pg.Pool,
  escalationId: string,
  adminUserId: string,
): Promise<EscalationRow | undefined> {
  const result = await query<EscalationRow>(
    pool,
    `UPDATE ops.escalations
     SET resolution_requested_by = $2, resolution_requested_at = now()
     WHERE escalation_id = $1 AND status = 'open'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, adminUserId],
  );
  return result.rows[0];
}

/**
 * 「裁定の記録待ち」を解除する(管理者が「キャンセル」を送ったとき)。
 * 受付状態(resolution_requested_*)のみクリアし、裁定・ステータスには触れない
 * (記録系データを巻き戻さない)。既に解除済みでも壊れない(冪等)。
 */
export async function cancelResolutionRecording(
  pool: pg.Pool,
  escalationId: string,
): Promise<void> {
  await query(
    pool,
    `UPDATE ops.escalations
     SET resolution_requested_by = NULL, resolution_requested_at = NULL
     WHERE escalation_id = $1 AND status = 'open'`,
    [escalationId],
  );
}

/**
 * 「裁定待ち」のエスカレーションを探す: 本人が直近15分以内に「裁定を記録」を押した open のもの。
 * (suggestions の「理由待ち」パターンの再利用)
 */
export async function findAwaitingResolution(
  pool: pg.Pool,
  adminUserId: string,
): Promise<EscalationRow | undefined> {
  const result = await query<EscalationRow>(
    pool,
    `SELECT ${ESCALATION_COLUMNS}
     FROM ops.escalations
     WHERE resolution_requested_by = $1
       AND status = 'open'
       AND resolution IS NULL
       AND resolution_requested_at > now() - INTERVAL '15 minutes'
     ORDER BY resolution_requested_at DESC
     LIMIT 1`,
    [adminUserId],
  );
  return result.rows[0];
}
