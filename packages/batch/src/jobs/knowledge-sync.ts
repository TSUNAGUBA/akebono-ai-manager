import {
  embedTexts,
  logger,
  optionalEnv,
  query,
  toVectorLiteral,
} from '@ai-manager/shared';
import type pg from 'pg';
import { chunkDocument } from '../chunking.js';
import { classifyDocument, fetchFileText, listFilesRecursive } from '../drive.js';
import type { JobSummary } from './morning-checkin.js';

/**
 * ナレッジ同期(M1): Drive → チャンク分割 → 差分のみ embedding → rag.knowledge_chunks UPSERT。
 * - content_hash 比較で変更チャンクのみ embedding し直す(コスト最小化)
 * - Drive から消えた文書・短くなった文書の余剰チャンクは削除する
 * - ファイル単位で非ブロッキング(1ファイルの失敗で全体を止めない)
 */
export async function runKnowledgeSync(pool: pg.Pool): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  const folderId = optionalEnv('KNOWLEDGE_DRIVE_FOLDER_ID', '');
  if (folderId === '') {
    logger.warn('KNOWLEDGE_DRIVE_FOLDER_ID が未設定のためナレッジ同期をスキップします');
    return summary;
  }

  const files = await listFilesRecursive(folderId);
  // 削除掃除の保護対象は「Drive に存在する全ファイル」。
  // 取得に失敗したファイルのチャンクを誤って消さないよう、列挙時点で確定する。
  const seenDocIds = files.map((f) => f.id);

  // フォルダ規約のマスタ突合用(v0.3 §3.4)。1 回のロードで全ファイルを検証する
  const knownIndustries = new Set(
    (await query<{ industry_id: string }>(pool, 'SELECT industry_id FROM ops.industries')).rows.map(
      (r) => r.industry_id,
    ),
  );
  const knownCustomers = new Set(
    (await query<{ customer_id: string }>(pool, 'SELECT customer_id FROM ops.customers')).rows.map(
      (r) => r.customer_id,
    ),
  );

  for (const file of files) {
    try {
      const text = await fetchFileText(file);
      if (text === undefined || text.trim() === '') {
        summary.skipped += 1;
        continue;
      }

      const classified = classifyDocument(file);
      const { docType, customerId } = classified;
      // 業界がマスタに無い場合は NULL で取り込み+警告(取り込みは止めない: v0.3 §3.4)
      let industryId = classified.industryId;
      if (industryId !== null && !knownIndustries.has(industryId)) {
        logger.warn('フォルダ規約の業界がマスタに存在しません(industry_id なしで取り込み)', {
          docId: file.id,
          name: file.name,
          path: file.path,
          industryId,
          hint: 'ダッシュボードの業界マスタに追加するか、domain/ 配下のフォルダ名を合わせてください',
        });
        industryId = null;
      }
      if (customerId !== null && !knownCustomers.has(customerId)) {
        logger.warn('フォルダ規約の顧客IDがマスタに存在しません(取り込みは継続)', {
          docId: file.id,
          name: file.name,
          path: file.path,
          customerId,
          hint: '顧客マスタの customer_id とフォルダ名を一致させると顧客スコープ検索が有効になります',
        });
      }
      const chunks = chunkDocument(text);

      const existing = await query<{ chunk_index: number; content_hash: string }>(
        pool,
        'SELECT chunk_index, content_hash FROM rag.knowledge_chunks WHERE doc_id = $1',
        [file.id],
      );
      const existingHashes = new Map(existing.rows.map((r) => [r.chunk_index, r.content_hash]));

      const changed = chunks.filter((c) => existingHashes.get(c.index) !== c.hash);
      if (changed.length > 0) {
        const embeddings = await embedTexts(
          changed.map((c) => c.text),
          'RETRIEVAL_DOCUMENT',
        );
        for (const [i, chunk] of changed.entries()) {
          const embedding = embeddings[i];
          if (embedding === undefined) continue;
          await query(
            pool,
            `INSERT INTO rag.knowledge_chunks
               (doc_id, doc_type, customer_id, industry_id, title, chunk_index, chunk_text, embedding, content_hash, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, now())
             ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
               doc_type = EXCLUDED.doc_type,
               customer_id = EXCLUDED.customer_id,
               industry_id = EXCLUDED.industry_id,
               title = EXCLUDED.title,
               chunk_text = EXCLUDED.chunk_text,
               embedding = EXCLUDED.embedding,
               content_hash = EXCLUDED.content_hash,
               updated_at = now()`,
            [
              file.id,
              docType,
              customerId,
              industryId,
              file.name,
              chunk.index,
              chunk.text,
              toVectorLiteral(embedding),
              chunk.hash,
            ],
          );
        }
      }

      // 本文が変わらなくても分類(業界・顧客・doc_type)は追従させる(v0.3 §6-3。
      // 既存チャンクへの industry_id 付与はこの経路で行われ、embedding は再計算しない)
      await query(
        pool,
        `UPDATE rag.knowledge_chunks
            SET doc_type = $2, customer_id = $3, industry_id = $4, updated_at = now()
          WHERE doc_id = $1
            AND (doc_type IS DISTINCT FROM $2
                 OR customer_id IS DISTINCT FROM $3
                 OR industry_id IS DISTINCT FROM $4)`,
        [file.id, docType, customerId, industryId],
      );

      // 文書が短くなった場合の余剰チャンクを削除
      await query(
        pool,
        'DELETE FROM rag.knowledge_chunks WHERE doc_id = $1 AND chunk_index >= $2',
        [file.id, chunks.length],
      );

      if (changed.length > 0) {
        logger.info('ナレッジ文書を同期しました', {
          docId: file.id,
          name: file.name,
          docType,
          updatedChunks: changed.length,
          totalChunks: chunks.length,
        });
        summary.sent += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      logger.error('ナレッジ文書の同期に失敗しました(次のファイルへ継続)', err, {
        docId: file.id,
        name: file.name,
      });
      summary.failed += 1;
    }
  }

  // Drive から削除された文書のチャンクを削除(全ファイル列挙に成功した場合のみ)。
  // doc_id='escalation/{id}' のチャンクは Drive 由来ではなく、SoT が ops.escalations にある
  // 裁定ナレッジのキャッシュ(chat-gateway が還流)のため、掃除対象から除外する。
  try {
    if (files.length > 0) {
      await query(
        pool,
        `DELETE FROM rag.knowledge_chunks
         WHERE NOT (doc_id = ANY($1::text[]))
           AND doc_id NOT LIKE 'escalation/%'`,
        [seenDocIds],
      );
    }
  } catch (err) {
    logger.error('削除済み文書のチャンク掃除に失敗しました(処理は継続)', err);
  }

  return summary;
}
