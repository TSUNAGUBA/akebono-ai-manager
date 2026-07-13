import { describe, expect, it } from 'vitest';
import { fetchCustomerContext } from '../src/services/customer-context.js';
import { createMockPool, findCall, type Responder } from './mock-pool.js';

const shimamura = {
  customer_id: 'shimamura',
  name: 'しまむら',
  industries: ['小売業', 'アパレル'],
};

const supplyRelation = {
  from_name: 'undeux',
  to_name: 'しまむら',
  label: '納品先(メーカー→小売等)',
  notes: null,
};

function responderWith(relations: unknown[]): Responder {
  return (text) => {
    if (text.includes('FROM ops.customers c')) return { rows: [shimamura] };
    if (text.includes('FROM ops.customer_relations')) return { rows: relations };
    return { rows: [] };
  };
}

describe('fetchCustomerContext(顧客マスタ情報のプロンプト供給)', () => {
  it('顧客情報と関係を $1=顧客ID で取得する(業界は主業界が先頭)', async () => {
    const { pool, calls } = createMockPool(responderWith([supplyRelation]));
    await fetchCustomerContext(pool, 'shimamura');

    const customerCall = findCall(calls, 'FROM ops.customers c');
    expect(customerCall?.params).toEqual(['shimamura']);
    expect(customerCall?.text).toContain('ci.is_primary DESC'); // 主業界を先頭に

    const relationCall = findCall(calls, 'FROM ops.customer_relations');
    expect(relationCall?.params).toEqual(['shimamura']);
    // 向き不問(from / to のどちらでも取得する)
    expect(relationCall?.text).toContain('r.from_customer_id = $1 OR r.to_customer_id = $1');
    expect(relationCall?.text).toContain('ops.relation_types'); // 関係種別ラベルを結合
  });

  it('しまむらシナリオ: 名称・業界・関係(種別ラベル付き)を整形して返す', async () => {
    const { pool } = createMockPool(responderWith([supplyRelation]));
    const block = await fetchCustomerContext(pool, 'shimamura');

    expect(block).toContain('しまむら(所属業界: 小売業、アパレル)');
    expect(block).toContain('- undeux → しまむら: 納品先(メーカー→小売等)');
    expect(block).not.toContain('備考'); // notes が NULL なら備考を出さない
  });

  it('notes があれば備考として付記する', async () => {
    const { pool } = createMockPool(
      responderWith([{ ...supplyRelation, notes: '値札レス納品あり' }]),
    );
    const block = await fetchCustomerContext(pool, 'shimamura');
    expect(block).toContain('納品先(メーカー→小売等) / 備考: 値札レス納品あり');
  });

  it('関係が未登録なら「登録済みの顧客間関係はありません」と明示する(AI が未登録を確定情報として伝えるため)', async () => {
    const { pool } = createMockPool(responderWith([]));
    const block = await fetchCustomerContext(pool, 'shimamura');
    expect(block).toContain('(この顧客に登録済みの顧客間関係はありません)');
  });

  it('業界が未登録なら「未登録」と表示する', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.customers c')) {
        return { rows: [{ ...shimamura, industries: [] }] };
      }
      return { rows: [] };
    });
    const block = await fetchCustomerContext(pool, 'shimamura');
    expect(block).toContain('しまむら(所属業界: 未登録)');
  });

  it('顧客がマスタに存在しなければ undefined を返す', async () => {
    const { pool } = createMockPool(() => ({ rows: [] }));
    await expect(fetchCustomerContext(pool, 'ghost')).resolves.toBeUndefined();
  });

  it('クエリ失敗時は undefined を返す(非ブロッキング: QA はナレッジのみで継続)', async () => {
    const { pool } = createMockPool(() => new Error('db down'));
    await expect(fetchCustomerContext(pool, 'shimamura')).resolves.toBeUndefined();
  });
});
