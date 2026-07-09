import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  identifyTargetCustomer,
  resolveKnowledgeScope,
  scopeFallbackMode,
} from '../src/services/knowledge-scope.js';
import { searchKnowledge } from '../src/services/rag.js';
import { createMockPool, findCall } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, embedTexts: mocks.embedTexts };
});

beforeEach(() => {
  mocks.embedTexts.mockClear();
  mocks.embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
  delete process.env['KNOWLEDGE_SCOPE_HOPS'];
  delete process.env['KNOWLEDGE_SCOPE_FALLBACK'];
});

afterEach(() => {
  delete process.env['KNOWLEDGE_SCOPE_HOPS'];
  delete process.env['KNOWLEDGE_SCOPE_FALLBACK'];
});

describe('resolveKnowledgeScope(到達可能集合の導出)', () => {
  it('再帰 CTE で $1=対象顧客・$2=ホップ数(既定 1)を発行する', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await resolveKnowledgeScope(pool, 'undeux');

    const call = findCall(calls, 'WITH RECURSIVE reach');
    expect(call).toBeDefined();
    expect(call?.text).toContain('ops.customer_relations');
    expect(call?.text).toContain('ops.customer_industries');
    expect(call?.text).toContain('reach.depth < $2');
    expect(call?.params).toEqual(['undeux', 1]);
  });

  it('KNOWLEDGE_SCOPE_HOPS=2 で $2=2 になる', async () => {
    process.env['KNOWLEDGE_SCOPE_HOPS'] = '2';
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await resolveKnowledgeScope(pool, 'undeux');
    expect(findCall(calls, 'WITH RECURSIVE reach')?.params).toEqual(['undeux', 2]);
  });

  it('KNOWLEDGE_SCOPE_HOPS は最大 2 にクランプされる(5 → 2)', async () => {
    process.env['KNOWLEDGE_SCOPE_HOPS'] = '5';
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await resolveKnowledgeScope(pool, 'undeux');
    expect(findCall(calls, 'WITH RECURSIVE reach')?.params).toEqual(['undeux', 2]);
  });

  it('KNOWLEDGE_SCOPE_HOPS は最小 1 にクランプされる(0 → 1)', async () => {
    process.env['KNOWLEDGE_SCOPE_HOPS'] = '0';
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await resolveKnowledgeScope(pool, 'undeux');
    expect(findCall(calls, 'WITH RECURSIVE reach')?.params).toEqual(['undeux', 1]);
  });

  it('undeux/しまむらシナリオ: 到達可能集合と業界をそのまま返す', async () => {
    // undeux --納品先--> しまむら(1ホップ)。undeux はアパレル業界に帰属
    const { pool } = createMockPool(() => ({
      rows: [{ customer_ids: ['undeux', 'shimamura'], industry_ids: ['apparel'] }],
    }));
    const scope = await resolveKnowledgeScope(pool, 'undeux');
    expect(scope).toEqual({ customerIds: ['undeux', 'shimamura'], industryIds: ['apparel'] });
  });

  it('結果行が空でも対象顧客自身にフォールバックする', async () => {
    const { pool } = createMockPool(() => ({ rows: [] }));
    const scope = await resolveKnowledgeScope(pool, 'undeux');
    expect(scope).toEqual({ customerIds: ['undeux'], industryIds: [] });
  });
});

describe('identifyTargetCustomer(対象顧客の特定)', () => {
  it('優先順①: 対話文脈の顧客 ID があればマスタ照合せず即座に返す', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    const id = await identifyTargetCustomer(pool, 'しまむら向けの納期は?', 'undeux');
    expect(id).toBe('undeux');
    expect(calls).toHaveLength(0); // SQL を発行しない
  });

  it('優先順②: 文脈がなければ質問文を $1 に渡して顧客名/ID をマスタ照合する', async () => {
    const { pool, calls } = createMockPool(() => ({
      rows: [{ customer_id: 'shimamura', name: 'しまむら' }],
    }));
    const id = await identifyTargetCustomer(pool, 'しまむらの在庫連携の仕様は?');

    expect(id).toBe('shimamura');
    const call = findCall(calls, 'FROM ops.customers');
    expect(call?.params).toEqual(['しまむらの在庫連携の仕様は?']);
    expect(call?.text).toContain('ILIKE'); // 名称の部分一致照合
    expect(call?.text).toContain('length(name) >= 2'); // 1文字名の過剰一致防止
    expect(call?.text).toContain('ORDER BY length(name) DESC'); // 最長一致を採用
  });

  it('文脈が null / 空文字なら文脈扱いせずマスタ照合に進む', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await identifyTargetCustomer(pool, '質問', null);
    await identifyTargetCustomer(pool, '質問', '');
    expect(calls.filter((c) => c.text.includes('FROM ops.customers'))).toHaveLength(2);
  });

  it('照合ヒットなしなら undefined(呼び出し元がフォールバック動作を選ぶ)', async () => {
    const { pool } = createMockPool(() => ({ rows: [] }));
    await expect(identifyTargetCustomer(pool, '一般的な質問')).resolves.toBeUndefined();
  });
});

describe('scopeFallbackMode(特定不能時の動作)', () => {
  it('既定は exclude-customer(顧客固有ナレッジの誤混入防止)', () => {
    expect(scopeFallbackMode()).toBe('exclude-customer');
  });

  it("KNOWLEDGE_SCOPE_FALLBACK=all で全域検索(v0.2 互換)へ切り替わる", () => {
    process.env['KNOWLEDGE_SCOPE_FALLBACK'] = 'all';
    expect(scopeFallbackMode()).toBe('all');
  });

  it('未知の値は安全側の exclude-customer に倒す', () => {
    process.env['KNOWLEDGE_SCOPE_FALLBACK'] = 'everything';
    expect(scopeFallbackMode()).toBe('exclude-customer');
  });
});

describe('searchKnowledge(スコープ3態の SQL パラメータ)', () => {
  const scopeFilterFragment = 'customer_id = ANY($5::text[])';

  it('KnowledgeScope 指定: $4=false・$5=顧客集合・$6=業界集合で前置フィルタする', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await searchKnowledge(pool, '納期の考え方は?', {
      scope: { customerIds: ['c1'], industryIds: ['i1', 'i2'] },
    });

    const call = findCall(calls, 'FROM rag.knowledge_chunks');
    expect(call?.text).toContain(scopeFilterFragment);
    expect(call?.text).toContain('industry_id = ANY($6::text[])');
    expect(call?.params[3]).toBe(false); // $4: 顧客固有の除外ではない
    expect(call?.params[4]).toEqual(['c1']); // $5: スコープ内顧客
    expect(call?.params[5]).toEqual(['i1', 'i2']); // $6: スコープ内業界
  });

  it("'exclude-customer' 指定: $4=true で顧客固有を除外し、$5=NULL/$6=[] で素通しする", async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await searchKnowledge(pool, '一般的な質問');
    const undefinedCall = calls[0];

    await searchKnowledge(pool, '一般的な質問', { scope: 'exclude-customer' });
    const call = calls[1];

    expect(call?.params[3]).toBe(true); // $4: 顧客固有を除外
    expect(call?.params[4]).toBeNull(); // $5: 顧客集合は無指定
    expect(call?.params[5]).toEqual([]); // $6: 業界集合は無指定

    // undefined(全域検索)との差分は $4 のみ
    expect(undefinedCall?.params[3]).toBe(false);
    expect(undefinedCall?.params[4]).toBeNull();
    expect(undefinedCall?.params[5]).toEqual([]);
  });

  it('undefined(全域検索): $4=false・$5=NULL で v0.2 互換の無フィルタになる', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await searchKnowledge(pool, '例え話がほしい', { docTypes: ['analogy'], limit: 3 });

    const call = findCall(calls, 'FROM rag.knowledge_chunks');
    expect(call?.params[1]).toEqual(['analogy']); // $2: docTypes
    expect(call?.params[2]).toBe(3); // $3: limit
    expect(call?.params[3]).toBe(false);
    expect(call?.params[4]).toBeNull();
    expect(call?.params[5]).toEqual([]);
  });

  it('undeux/しまむらシナリオのパラメータ回帰: 到達可能集合がそのまま $5/$6 に渡る', async () => {
    // undeux を対象顧客とすると、1ホップでしまむらに到達し、業界はアパレル。
    // 検索は「undeux 固有+しまむら固有+アパレル業界+共通」に絞られる(v0.3 §4 例2)
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await searchKnowledge(pool, 'しまむら向けの値札仕様は?', {
      docTypes: ['customer_profile', 'glossary', 'domain_ops', 'decision_rules'],
      limit: 5,
      scope: { customerIds: ['undeux', 'shimamura'], industryIds: ['apparel'] },
    });

    const call = findCall(calls, 'FROM rag.knowledge_chunks');
    expect(call?.params[3]).toBe(false);
    expect(call?.params[4]).toEqual(['undeux', 'shimamura']);
    expect(call?.params[5]).toEqual(['apparel']);
    // 共通ナレッジ(customer_id も industry_id も NULL)は常に検索対象に残る
    expect(call?.text).toContain('(customer_id IS NULL AND industry_id IS NULL)');
  });
});
