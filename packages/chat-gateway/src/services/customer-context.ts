import { logger, query } from '@ai-manager/shared';
import type pg from 'pg';

/**
 * 顧客コンテキスト(マスタ由来の構造情報)のプロンプト供給(要件 v0.7 §3)。
 *
 * マスタ(ops.customers / customer_industries / customer_relations)は従来
 * ナレッジ検索のスコープ導出(絞り込み)にのみ使われ、マスタに登録された事実
 * (取引先の一覧・所属業界)は AI の参考情報に渡っていなかった。
 * 本サービスは対象顧客の構造情報を決定的 SQL で取得し、プロンプトに埋め込む
 * テキストブロックへ整形する。
 *
 * SoT(ops マスタ)をクエリ時に直接参照する(ADR-13)。rag への文書化同期は
 * 行わない: 同期パスの追加は鮮度劣化・削除同期漏れの温床であり(開発原則 6)、
 * ベクトル検索経由では列挙質問で確実にヒットする保証もないため。
 */

interface CustomerRow {
  customer_id: string;
  name: string;
  industries: string[];
}

interface RelationRow {
  from_name: string;
  to_name: string;
  label: string;
  notes: string | null;
}

/**
 * 対象顧客のマスタ情報(名称・所属業界・1ホップの顧客間関係)を取得し、
 * プロンプト用テキストに整形する。
 * 補助情報のため非ブロッキング(開発原則 4): 取得失敗は undefined を返し、
 * 呼び出し元は従来どおりナレッジのみで回答する。
 */
export async function fetchCustomerContext(
  pool: pg.Pool,
  customerId: string,
): Promise<string | undefined> {
  try {
    const [customerResult, relationsResult] = await Promise.all([
      query<CustomerRow>(
        pool,
        `SELECT c.customer_id, c.name,
                COALESCE(
                  array_agg(i.name ORDER BY ci.is_primary DESC, i.name)
                    FILTER (WHERE i.name IS NOT NULL),
                  '{}'
                ) AS industries
           FROM ops.customers c
           LEFT JOIN ops.customer_industries ci ON ci.customer_id = c.customer_id
           LEFT JOIN ops.industries i ON i.industry_id = ci.industry_id
          WHERE c.customer_id = $1
          GROUP BY c.customer_id, c.name`,
        [customerId],
      ),
      query<RelationRow>(
        pool,
        `SELECT cf.name AS from_name, ct.name AS to_name, rt.label, r.notes
           FROM ops.customer_relations r
           JOIN ops.relation_types rt ON rt.relation_type = r.relation_type
           JOIN ops.customers cf ON cf.customer_id = r.from_customer_id
           JOIN ops.customers ct ON ct.customer_id = r.to_customer_id
          WHERE r.from_customer_id = $1 OR r.to_customer_id = $1
          ORDER BY cf.name, ct.name, rt.label`,
        [customerId],
      ),
    ]);

    const customer = customerResult.rows[0];
    if (customer === undefined) return undefined;

    return formatCustomerContext(customer, relationsResult.rows);
  } catch (err) {
    logger.error('顧客マスタ情報の取得に失敗しました(ナレッジのみで回答を継続)', err, {
      customerId,
    });
    return undefined;
  }
}

/** マスタ情報のテキスト整形(決定的。LLM には事実のみ渡し、解釈は委ねる)。 */
function formatCustomerContext(customer: CustomerRow, relations: RelationRow[]): string {
  const industries = customer.industries.length === 0 ? '未登録' : customer.industries.join('、');
  const lines = [
    '### 対象顧客',
    `- ${customer.name}(所属業界: ${industries})`,
    '',
    '### 顧客間関係(登録済みの取引・連携関係)',
  ];
  if (relations.length === 0) {
    lines.push('(この顧客に登録済みの顧客間関係はありません)');
  } else {
    for (const r of relations) {
      const notes = r.notes === null || r.notes === '' ? '' : ` / 備考: ${r.notes}`;
      lines.push(`- ${r.from_name} → ${r.to_name}: ${r.label}${notes}`);
    }
  }
  return lines.join('\n');
}
