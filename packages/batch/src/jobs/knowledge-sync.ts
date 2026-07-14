import {
  embedTexts,
  ERROR_CODES,
  listFilesRecursive,
  logger,
  optionalEnv,
  query,
  toVectorLiteral,
} from '@ai-manager/shared';
import type pg from 'pg';
import { chunkDocument } from '../chunking.js';
import { classifyDocument, fetchFileText } from '../drive.js';
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

  const { files, unresolvedShortcuts } = await listFilesRecursive(folderId);
  if (unresolvedShortcuts.length > 0) {
    logger.warn('アクセスできないショートカットがあります(先を読めないため同期対象外)', {
      errorCode: ERROR_CODES.DRIVE_SYNC_FAILED,
      shortcuts: unresolvedShortcuts.slice(0, 20),
      hint: 'ショートカットは Drive の共有権限を引き継ぎません。実体フォルダをナレッジフォルダ内へ移動するか、ショートカット先をランタイム SA に共有してください(deployment-setup.md Step 7-3)',
    });
  }
  if (files.length === 0) {
    logger.warn('ナレッジフォルダにファイルが見つかりません(同期対象なし)', {
      errorCode: ERROR_CODES.DRIVE_SYNC_FAILED,
      folderId,
      hint: 'KNOWLEDGE_DRIVE_FOLDER_ID のフォルダ ID が意図した場所か、フォルダがランタイム SA に共有されているかを、ダッシュボードのナレッジ管理ページ(文書一覧)で確認してください',
    });
  }
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
  const knownProjects = new Set(
    (await query<{ project_id: string }>(pool, 'SELECT project_id FROM ops.projects')).rows.map(
      (r) => r.project_id,
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
      const { docType, customerId, projectId } = classified;
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
      // プロジェクトIDも顧客IDと同じ扱い(v0.12 §4): マスタに無くても project_id は保持して
      // 取り込みを継続する(マスタ登録が後追いでも、登録し直しなしでスコープ検索が有効になる)
      if (projectId !== null && !knownProjects.has(projectId)) {
        logger.warn('フォルダ規約のプロジェクトIDがマスタに存在しません(取り込みは継続)', {
          docId: file.id,
          name: file.name,
          path: file.path,
          projectId,
          hint: 'プロジェクトマスタの project_id とフォルダ名を一致させるとプロジェクトスコープ検索が有効になります',
        });
      }
      // project/ 直下(IDセグメントなし)は規約外配置: どのプロジェクトにも帰属できない。
      // 取り込みは継続する(顧客ID不一致と同じ非ブロッキング)が、意図した配置か気づけるよう警告する
      if (docType === 'project_doc' && projectId === null) {
        logger.warn('project/ 直下に文書が置かれています(プロジェクト帰属なしで取り込み)', {
          docId: file.id,
          name: file.name,
          path: file.path,
          hint: 'project/{プロジェクトID}/ 配下へ移動するとプロジェクトスコープ検索の対象になります',
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
               (doc_id, doc_type, customer_id, industry_id, project_id, title, chunk_index, chunk_text, embedding, content_hash, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, now())
             ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
               doc_type = EXCLUDED.doc_type,
               customer_id = EXCLUDED.customer_id,
               industry_id = EXCLUDED.industry_id,
               project_id = EXCLUDED.project_id,
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
              projectId,
              file.name,
              chunk.index,
              chunk.text,
              toVectorLiteral(embedding),
              chunk.hash,
            ],
          );
        }
      }

      // 本文が変わらなくても分類(業界・顧客・プロジェクト・doc_type)は追従させる(v0.3 §6-3。
      // 既存チャンクへの industry_id / project_id 付与はこの経路で行われ、embedding は再計算しない)
      await query(
        pool,
        `UPDATE rag.knowledge_chunks
            SET doc_type = $2, customer_id = $3, industry_id = $4, project_id = $5, updated_at = now()
          WHERE doc_id = $1
            AND (doc_type IS DISTINCT FROM $2
                 OR customer_id IS DISTINCT FROM $3
                 OR industry_id IS DISTINCT FROM $4
                 OR project_id IS DISTINCT FROM $5)`,
        [file.id, docType, customerId, industryId, projectId],
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
  // アクセスできないショートカットがある場合は、その配下のファイルを列挙できておらず
  // 「削除された」と誤判定し得るため、掃除をスキップして既存チャンクを保護する(原則2)。
  // doc_id='escalation/{id}'(SoT: ops.escalations の裁定 — chat-gateway/batch が還流)と
  // doc_id='feedback/{id}'(SoT: ops.dialogue_feedback — dialogue-feedback ジョブが還流。v0.12 §7)の
  // チャンクは Drive 由来ではない還流キャッシュのため、掃除対象から除外する。
  try {
    if (unresolvedShortcuts.length > 0) {
      logger.warn(
        'アクセスできないショートカットがあるため、削除済み文書のチャンク掃除をスキップします(解消まで、Drive から削除した文書が検索に残り続けます)',
        { errorCode: ERROR_CODES.DRIVE_SYNC_FAILED },
      );
    } else if (files.length > 0) {
      await query(
        pool,
        `DELETE FROM rag.knowledge_chunks
         WHERE NOT (doc_id = ANY($1::text[]))
           AND doc_id NOT LIKE 'escalation/%'
           AND doc_id NOT LIKE 'feedback/%'`,
        [seenDocIds],
      );
    }
  } catch (err) {
    logger.error('削除済み文書のチャンク掃除に失敗しました(処理は継続)', err);
  }

  return summary;
}
