import { createHash } from 'node:crypto';

/**
 * ナレッジ文書のチャンク分割(要件 7.4)。
 * 見出し単位で分割し、500〜1000字を目安に統合・分割する。オーバーラップ100字。
 */
export interface Chunk {
  index: number;
  text: string;
  hash: string;
}

const MAX_CHUNK_CHARS = 1000;
const MIN_CHUNK_CHARS = 500;
const OVERLAP_CHARS = 100;

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 見出し(# 行)でセクションに分割する。見出しがなければ空行区切りの段落単位。 */
function splitSections(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n').trim();
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n').trim());
  return sections.filter((s) => s !== '');
}

/** 長いセクションを最大長以下に分割する(段落境界を優先、なければ固定長)。 */
function splitLongSection(section: string): string[] {
  if (section.length <= MAX_CHUNK_CHARS) return [section];
  const paragraphs = section.split(/\n{2,}/);
  const parts: string[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (buffer !== '' && buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(buffer);
      buffer = '';
    }
    if (paragraph.length > MAX_CHUNK_CHARS) {
      if (buffer !== '') {
        parts.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < paragraph.length; i += MAX_CHUNK_CHARS) {
        parts.push(paragraph.slice(i, i + MAX_CHUNK_CHARS));
      }
    } else {
      buffer = buffer === '' ? paragraph : `${buffer}\n\n${paragraph}`;
    }
  }
  if (buffer !== '') parts.push(buffer);
  return parts;
}

/** 文書全体をチャンク列に変換する。 */
export function chunkDocument(text: string): Chunk[] {
  const sections = splitSections(text).flatMap(splitLongSection);

  // 小さいセクションは 500 字を目安に統合する
  const merged: string[] = [];
  let buffer = '';
  for (const section of sections) {
    if (buffer === '') {
      buffer = section;
    } else if (buffer.length < MIN_CHUNK_CHARS && buffer.length + section.length + 2 <= MAX_CHUNK_CHARS) {
      buffer = `${buffer}\n\n${section}`;
    } else {
      merged.push(buffer);
      buffer = section;
    }
  }
  if (buffer !== '') merged.push(buffer);

  // 前チャンク末尾のオーバーラップを付与(検索時の文脈切れ防止)
  return merged.map((chunkText, index) => {
    const withOverlap =
      index === 0
        ? chunkText
        : `…${(merged[index - 1] ?? '').slice(-OVERLAP_CHARS)}\n\n${chunkText}`;
    return { index, text: withOverlap, hash: hashText(withOverlap) };
  });
}
