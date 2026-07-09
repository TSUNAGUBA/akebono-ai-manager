import { createHash } from 'node:crypto';
import {
  embedTexts,
  escalationCard,
  escalationReasonLabel,
  logger,
  optionalEnv,
  query,
  sendChatMessage,
  toVectorLiteral,
} from '@ai-manager/shared';
import type pg from 'pg';

/**
 * エスカレーション(M6)。
 * SoT: ops.escalations(裁定 resolution を含む)。
 * rag.knowledge_chunks の doc_id='escalation/{id}' チャンクは SoT からの還流キャッシュであり、
 * SoT への書込(裁定の保存)を先に行い、キャッシュ(ベクトル)は後から反映する。
 */

export interface EscalationRow {
  escalation_id: string; // BIGINT は pg で文字列になる
  reason: string;
  context: string;
  status: string;
  resolution: string | null;
  knowledge_reflected: boolean;
}

const ESCALATION_COLUMNS =
  'escalation_id, reason, context, status, resolution, knowledge_reflected';

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

export async function getEscalation(
  pool: pg.Pool,
  escalationId: string,
): Promise<EscalationRow | undefined> {
  const result = await query<EscalationRow>(
    pool,
    `SELECT ${ESCALATION_COLUMNS} FROM ops.escalations WHERE escalation_id = $1`,
    [escalationId],
  );
  return result.rows[0];
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

/**
 * 裁定を SoT(ops.escalations)へ保存する。open のもののみ対象(裁定済みを上書きしない)。
 * @returns 保存できた場合は更新後の行、既に裁定済みの場合は undefined
 */
export async function recordResolution(
  pool: pg.Pool,
  escalationId: string,
  adminUserId: string,
  resolutionText: string,
): Promise<EscalationRow | undefined> {
  const result = await query<EscalationRow>(
    pool,
    `UPDATE ops.escalations
     SET resolution = $3, status = 'resolved', resolved_by = $2, resolved_at = now()
     WHERE escalation_id = $1 AND status = 'open'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, adminUserId, resolutionText],
  );
  return result.rows[0];
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 裁定をナレッジ(decision_rules)へ還流する(M6)。
 * SoT は ops.escalations.resolution。rag.knowledge_chunks はそのキャッシュであり、
 * doc_id='escalation/{id}' で UPSERT する(再実行しても壊れない)。
 * 成功後に knowledge_reflected を立てる。失敗時は false のまま残り、
 * 「裁定を記録」ボタンの再押下で再還流できる(手動回復パス)。
 */
export async function refluxResolutionToKnowledge(
  pool: pg.Pool,
  escalation: Pick<EscalationRow, 'escalation_id' | 'reason' | 'context' | 'resolution'>,
): Promise<void> {
  if (escalation.resolution === null || escalation.resolution === '') {
    throw new Error('裁定が未記録のため還流できません');
  }
  const chunkText = [
    `## 状況(${escalationReasonLabel(escalation.reason)})`,
    escalation.context,
    '',
    '## 裁定',
    escalation.resolution,
  ].join('\n');

  const [embedding] = await embedTexts([chunkText], 'RETRIEVAL_DOCUMENT');
  if (embedding === undefined) {
    throw new Error('裁定チャンクの embedding 生成結果が空でした');
  }

  await query(
    pool,
    `INSERT INTO rag.knowledge_chunks
       (doc_id, doc_type, customer_id, title, chunk_index, chunk_text, embedding, content_hash, updated_at)
     VALUES ($1, 'decision_rules', NULL, $2, 0, $3, $4::vector, $5, now())
     ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
       title = EXCLUDED.title,
       chunk_text = EXCLUDED.chunk_text,
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       updated_at = now()`,
    [
      `escalation/${escalation.escalation_id}`,
      `裁定: エスカレーション #${escalation.escalation_id}`,
      chunkText,
      toVectorLiteral(embedding),
      hashText(chunkText),
    ],
  );
  await query(
    pool,
    `UPDATE ops.escalations SET knowledge_reflected = TRUE WHERE escalation_id = $1`,
    [escalation.escalation_id],
  );
}
