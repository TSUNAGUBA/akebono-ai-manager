import { embedTexts, query, toVectorLiteral } from '@ai-manager/shared';
import type pg from 'pg';

export interface KnowledgeChunk {
  doc_type: string;
  customer_id: string | null;
  title: string | null;
  chunk_text: string;
  score: number;
}

/**
 * ナレッジ検索(rag.knowledge_chunks)。
 * コサイン距離 + doc_type の事前フィルタ(要件 7.4)。
 */
export async function searchKnowledge(
  pool: pg.Pool,
  queryText: string,
  options: { docTypes?: string[]; limit?: number } = {},
): Promise<KnowledgeChunk[]> {
  const [embedding] = await embedTexts([queryText], 'RETRIEVAL_QUERY');
  if (embedding === undefined) return [];
  const vector = toVectorLiteral(embedding);
  const result = await query<KnowledgeChunk & { score: string }>(
    pool,
    `SELECT doc_type, customer_id, title, chunk_text,
            (1 - (embedding <=> $1::vector))::float8 AS score
     FROM rag.knowledge_chunks
     WHERE embedding IS NOT NULL
       AND ($2::text[] IS NULL OR doc_type = ANY($2::text[]))
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vector, options.docTypes ?? null, options.limit ?? 5],
  );
  return result.rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** 参考情報ブロックの整形(プロンプトに埋め込む)。 */
export function formatKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '(該当するナレッジは見つかりませんでした)';
  return chunks
    .map((c, i) => `【参考${i + 1}: ${c.title ?? c.doc_type}】\n${c.chunk_text}`)
    .join('\n\n');
}

/** 例え話ライブラリの few-shot 検索(doc_type = analogy)。 */
export async function searchAnalogies(pool: pg.Pool, queryText: string): Promise<KnowledgeChunk[]> {
  return searchKnowledge(pool, queryText, { docTypes: ['analogy'], limit: 3 });
}
