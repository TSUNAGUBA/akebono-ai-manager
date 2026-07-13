import { logger, optionalEnv, optionalIntEnv, query } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * ナレッジ検索のスコープ導出(要件 v0.3 §4)。
 * 「誰と誰がどう繋がるか」(構造)は決定的 SQL で処理し、LLM に判断させない(設計原則 2)。
 */
export interface KnowledgeScope {
  /** 検索対象の顧客固有ナレッジ(対象顧客+関係先) */
  customerIds: string[];
  /** 検索対象の業界ドメインナレッジ(所属業界+関係先の業界) */
  industryIds: string[];
}

/**
 * 対象顧客から 1〜2 ホップの到達可能集合を導出する(向き不問)。
 * ホップ数の既定は 1(KNOWLEDGE_SCOPE_HOPS で 2 まで拡張可)。
 */
export async function resolveKnowledgeScope(
  pool: pg.Pool,
  targetCustomerId: string,
): Promise<KnowledgeScope> {
  const hops = Math.min(Math.max(optionalIntEnv('KNOWLEDGE_SCOPE_HOPS', 1), 1), 2);
  const result = await query<{ customer_ids: string[]; industry_ids: string[] }>(
    pool,
    `WITH RECURSIVE reach (customer_id, depth) AS (
       SELECT $1::text, 0
       UNION
       SELECT CASE WHEN r.from_customer_id = reach.customer_id
                   THEN r.to_customer_id ELSE r.from_customer_id END,
              reach.depth + 1
         FROM ops.customer_relations r
         JOIN reach ON reach.customer_id IN (r.from_customer_id, r.to_customer_id)
        WHERE reach.depth < $2
     )
     SELECT
       (SELECT array_agg(DISTINCT customer_id) FROM reach) AS customer_ids,
       (SELECT array_agg(DISTINCT ci.industry_id)
          FROM ops.customer_industries ci
          JOIN reach ON reach.customer_id = ci.customer_id) AS industry_ids`,
    [targetCustomerId, hops],
  );
  const row = result.rows[0];
  return {
    customerIds: row?.customer_ids ?? [targetCustomerId],
    industryIds: row?.industry_ids ?? [],
  };
}

/**
 * 質問の文脈から対象顧客を特定する(要件 v0.3 §4.3 を v0.7 §4 で改訂)。
 * 優先順: ①質問文中の顧客名/ID/エイリアスのマスタ照合(明示的な言及を最優先)
 *        ②対話文脈のプロジェクト顧客(呼び出し元が渡す)。
 * v0.3 では②①の順だったが、別顧客のタスクに着手中のメンバーが顧客名を明示して
 * 質問した際に、文脈顧客がスコープを誤った顧客側へ固定する失敗モードがあったため、
 * 明示一致を優先する順序へ変更した(v0.7 §4)。
 * 照合対象は名称・顧客ID・エイリアス(ops.customer_aliases)の UNION(v0.9 §4)。
 * 「株式会社しまむら」のような法人格付きの登録名は質問文に部分一致しないため、
 * 通称(「しまむら」)をエイリアスとして登録して照合できるようにする。
 * 複数一致時は最長一致(より具体的な表記)を採用する。
 * 照合の堅牢化: LIKE メタ文字(% _ \)をエスケープしてパターン誤解釈を防ぎ、
 * 1文字の表記(「A」等)による過剰一致を避けるため 2 文字以上のみ照合する
 * (エイリアスは DDL の CHECK でも 2 文字以上を担保)。
 */
export async function identifyTargetCustomer(
  pool: pg.Pool,
  text: string,
  contextCustomerId?: string | null,
): Promise<string | undefined> {
  try {
    const result = await query<{ customer_id: string; match_text: string }>(
      pool,
      `WITH candidates AS (
         SELECT customer_id, name AS match_text FROM ops.customers WHERE length(name) >= 2
         UNION ALL
         SELECT customer_id, customer_id AS match_text FROM ops.customers WHERE length(customer_id) >= 2
         UNION ALL
         SELECT customer_id, alias AS match_text FROM ops.customer_aliases
       ),
       escaped AS (
         SELECT customer_id, match_text,
                replace(replace(replace(match_text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') AS pattern
           FROM candidates
       )
       SELECT customer_id, match_text FROM escaped
        WHERE $1 ILIKE '%' || pattern || '%'
        ORDER BY length(match_text) DESC
        LIMIT 1`,
      [text],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      logger.debug('質問文から対象顧客を特定しました', {
        customerId: row.customer_id,
        matchedText: row.match_text,
      });
      return row.customer_id;
    }
  } catch (err) {
    // 名称照合は補助的な特定手段のため、失敗しても QA を止めない(開発原則 4)。
    // 文脈顧客があればそのスコープで、なければ呼び出し元のフォールバック動作で継続する
    logger.error('顧客名のマスタ照合に失敗しました(対話文脈の顧客で継続)', err);
  }
  if (contextCustomerId !== undefined && contextCustomerId !== null && contextCustomerId !== '') {
    return contextCustomerId;
  }
  return undefined;
}

/**
 * 対象顧客が特定できない場合の動作(要件 v0.3 §4.2)。
 * 既定 'exclude-customer': 顧客固有ナレッジを除外(誤混入防止をヒット率より優先)。
 * 'all': v0.2 までの全域検索(運用データで過剰な絞り込みと判明した場合の切替フラグ)。
 */
export function scopeFallbackMode(): 'exclude-customer' | 'all' {
  const raw = optionalEnv('KNOWLEDGE_SCOPE_FALLBACK', 'exclude-customer');
  return raw === 'all' ? 'all' : 'exclude-customer';
}
