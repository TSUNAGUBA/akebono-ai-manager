import { embedTexts, query, toVectorLiteral } from '@ai-manager/shared';
import type pg from 'pg';

import type { KnowledgeScope } from './knowledge-scope.js';

export interface KnowledgeChunk {
  doc_type: string;
  customer_id: string | null;
  title: string | null;
  chunk_text: string;
  score: number;
}

export interface SearchOptions {
  docTypes?: string[];
  limit?: number;
  /**
   * ナレッジスコープ(要件 v0.3 §4)。
   * - KnowledgeScope: スコープ内の顧客固有+スコープ内業界ドメイン+共通のみを検索
   * - 'exclude-customer': 顧客固有を除外(対象顧客が特定できない場合の既定)
   * - undefined: 全域検索(v0.2 互換。例え話などの共通ナレッジ用)
   */
  scope?: KnowledgeScope | 'exclude-customer';
}

/**
 * ナレッジ検索(rag.knowledge_chunks)。
 * 「構造で絞り、意味で並べる」: スコープを WHERE で前置フィルタし、コサイン距離で並べる。
 */
export async function searchKnowledge(
  pool: pg.Pool,
  queryText: string,
  options: SearchOptions = {},
): Promise<KnowledgeChunk[]> {
  const [embedding] = await embedTexts([queryText], 'RETRIEVAL_QUERY');
  if (embedding === undefined) return [];
  const vector = toVectorLiteral(embedding);

  const scope = options.scope;
  // customerIds / industryIds が NULL(=無指定)の場合は各条件を素通しにする
  const scopeCustomerIds = scope !== undefined && scope !== 'exclude-customer' ? scope.customerIds : null;
  const scopeIndustryIds = scope !== undefined && scope !== 'exclude-customer' ? scope.industryIds : null;
  const excludeCustomer = scope === 'exclude-customer';

  const result = await query<KnowledgeChunk & { score: string }>(
    pool,
    `SELECT doc_type, customer_id, title, chunk_text,
            (1 - (embedding <=> $1::vector))::float8 AS score
     FROM rag.knowledge_chunks
     WHERE embedding IS NOT NULL
       AND ($2::text[] IS NULL OR doc_type = ANY($2::text[]))
       AND (NOT $4::boolean OR customer_id IS NULL)
       AND ($5::text[] IS NULL
            OR (customer_id IS NULL AND industry_id IS NULL)
            OR customer_id = ANY($5::text[])
            OR (customer_id IS NULL AND industry_id = ANY($6::text[])))
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [
      vector,
      options.docTypes ?? null,
      options.limit ?? 5,
      excludeCustomer,
      scopeCustomerIds,
      scopeIndustryIds ?? [],
    ],
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
