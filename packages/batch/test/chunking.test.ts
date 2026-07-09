import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/chunking.js';

describe('chunkDocument', () => {
  it('空文書は空配列', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('  \n ')).toEqual([]);
  });

  it('短い文書は1チャンク', () => {
    const chunks = chunkDocument('# 概要\n種まきリストの説明。');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.text).toContain('種まきリスト');
  });

  it('見出し単位で分割し、小さいセクションは統合される', () => {
    const doc = [
      '# セクション1',
      'あ'.repeat(600),
      '# セクション2',
      'い'.repeat(600),
      '# 小さいセクション',
      '短い内容',
    ].join('\n');
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // インデックスが連番
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('長いセクションは最大長以下に分割される', () => {
    const doc = `# 長大セクション\n${'う'.repeat(3500)}`;
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // オーバーラップ分(100字+接頭)を含めても上限を大きく超えない
      expect(c.text.length).toBeLessThanOrEqual(1000 + 110);
    }
  });

  it('2チャンク目以降は前チャンクのオーバーラップを含む', () => {
    const doc = [`# A\n${'あ'.repeat(900)}`, `# B\n${'い'.repeat(900)}`].join('\n');
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBe(2);
    expect(chunks[1]?.text.startsWith('…')).toBe(true);
    expect(chunks[1]?.text).toContain('あ');
  });

  it('同じ内容は同じハッシュ、変更でハッシュが変わる', () => {
    const [a] = chunkDocument('# X\n内容1');
    const [b] = chunkDocument('# X\n内容1');
    const [c] = chunkDocument('# X\n内容2');
    expect(a?.hash).toBe(b?.hash);
    expect(a?.hash).not.toBe(c?.hash);
  });
});
