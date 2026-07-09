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

  for (const file of files) {
    try {
      const text = await fetchFileText(file);
      if (text === undefined || text.trim() === '') {
        summary.skipped += 1;
        continue;
      }

      const { docType, customerId } = classifyDocument(file);
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
               (doc_id, doc_type, customer_id, title, chunk_index, chunk_text, embedding, content_hash, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, now())
             ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
               doc_type = EXCLUDED.doc_type,
               customer_id = EXCLUDED.customer_id,
               title = EXCLUDED.title,
               chunk_text = EXCLUDED.chunk_text,
               embedding = EXCLUDED.embedding,
               content_hash = EXCLUDED.content_hash,
               updated_at = now()`,
            [
              file.id,
              docType,
              customerId,
              file.name,
              chunk.index,
              chunk.text,
              toVectorLiteral(embedding),
              chunk.hash,
            ],
          );
        }
      }

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

  // Drive から削除された文書のチャンクを削除(全ファイル列挙に成功した場合のみ)
  try {
    if (files.length > 0) {
      await query(
        pool,
        'DELETE FROM rag.knowledge_chunks WHERE NOT (doc_id = ANY($1::text[]))',
        [seenDocIds],
      );
    }
  } catch (err) {
    logger.error('削除済み文書のチャンク掃除に失敗しました(処理は継続)', err);
  }

  return summary;
}
