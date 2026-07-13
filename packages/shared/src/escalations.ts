import { createHash } from 'node:crypto';
import type pg from 'pg';
import { escalationReasonLabel } from './chat-cards.js';
import { query, toVectorLiteral } from './db.js';
import { embedTexts } from './vertex.js';

/**
 * エスカレーション(M6)の解決・ナレッジ還流の共通ロジック。
 * chat-gateway(「裁定を記録」の Chat フロー)と batch(ダッシュボードの解決アクション
 * escalation-action ジョブ — v0.12 §3)で共用する。
 *
 * SoT: ops.escalations(裁定 resolution を含む)。
 * rag.knowledge_chunks の doc_id='escalation/{id}' チャンクは SoT からの還流キャッシュであり、
 * SoT への書込(裁定の保存)を先に行い、キャッシュ(ベクトル)は後から反映する。
 */

/** 解決の種別(v0.12 §3)。NULL(旧データ)は 'ruling' 相当。 */
export type EscalationResolutionType = 'ruling' | 'admin_message' | 'no_action';

/**
 * 裁定・回答本文の文字数上限(v0.12 §3)。
 * chat-gateway(裁定ゲート)・batch(escalation-action)・dashboard(フォーム)の
 * 3パッケージ間のパラメータ契約のため、ここで一元管理する(片側だけの変更による
 * 「フォームは通るがジョブは 400」のドリフトを防ぐ)。
 */
export const RESOLUTION_TEXT_MAX_LENGTH = 1000;

/**
 * 還流の対象は裁定のみか(v0.12 §3 / ADR-18)。
 * admin_message(回答文)・no_action(解決メモ)を decision_rules ナレッジ化しない。
 * NULL は v0.12 以前の未分類(=裁定)として許可する。
 * Chat の再還流ボタン(card-action)・batch の reflux アクション・dashboard の
 * 再還流表示が共有する判定(消費者ごとの条件ドリフトを防ぐ)。
 */
export function isRefluxableResolutionType(resolutionType: string | null): boolean {
  return resolutionType === null || resolutionType === 'ruling';
}

export interface EscalationRow {
  escalation_id: string; // BIGINT は pg で文字列になる
  reason: string;
  context: string;
  status: string;
  resolution: string | null;
  resolution_type: string | null;
  related_user_id: string | null;
  knowledge_reflected: boolean;
}

export const ESCALATION_COLUMNS =
  'escalation_id, reason, context, status, resolution, resolution_type, related_user_id, knowledge_reflected';

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
 * 裁定・解決を SoT(ops.escalations)へ保存する。open のもののみ対象(解決済みを上書きしない)。
 * 保存成功時は、同一管理者の他の open な裁定受付状態(Chat の裁定ゲート)もクリアする:
 * 複数のエスカレーションで「裁定を記録」を押していた場合に、次のメッセージが
 * 別のゲートへ誤って取り込まれるのを防ぐ。裁定・ステータス自体には触れない。
 * @returns 保存できた場合は更新後の行、既に解決済みの場合は undefined
 */
export async function recordResolution(
  pool: pg.Pool,
  escalationId: string,
  adminUserId: string,
  resolutionText: string,
  resolutionType: EscalationResolutionType = 'ruling',
): Promise<EscalationRow | undefined> {
  const result = await query<EscalationRow>(
    pool,
    `UPDATE ops.escalations
     SET resolution = $3, resolution_type = $4, status = 'resolved', resolved_by = $2, resolved_at = now()
     WHERE escalation_id = $1 AND status = 'open'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, adminUserId, resolutionText, resolutionType],
  );
  const resolved = result.rows[0];
  if (resolved !== undefined) {
    await query(
      pool,
      `UPDATE ops.escalations
       SET resolution_requested_by = NULL, resolution_requested_at = NULL
       WHERE resolution_requested_by = $2 AND status = 'open' AND escalation_id <> $1`,
      [escalationId, adminUserId],
    );
  }
  return resolved;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 裁定をナレッジ(decision_rules)へ還流する(M6)。
 * SoT は ops.escalations.resolution。rag.knowledge_chunks はそのキャッシュであり、
 * doc_id='escalation/{id}' で UPSERT する(再実行しても壊れない)。
 * 成功後に knowledge_reflected を立てる。失敗時は false のまま残り、
 * 「裁定を記録」ボタンの再押下(Chat)またはダッシュボードの再還流で再試行できる(手動回復パス)。
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
