import { describe, expect, it } from 'vitest';
import {
  classifyMessage,
  looksLikeCompletionReport,
  tierForCategory,
} from '../src/routing.js';

describe('classifyMessage', () => {
  it('朝夕の対話コンテキスト内は常に thinking', () => {
    expect(classifyMessage('はい', 'morning_checkin')).toBe('thinking');
    expect(classifyMessage('終わりました', 'completion_review')).toBe('thinking');
  });

  it('挨拶・確認応答は routine', () => {
    expect(classifyMessage('おはようございます')).toBe('routine');
    expect(classifyMessage('了解です')).toBe('routine');
    expect(classifyMessage('ありがとうございます')).toBe('routine');
  });

  it('用語の質問は knowledge', () => {
    expect(classifyMessage('種まきリストとは?')).toBe('knowledge');
    expect(classifyMessage('WMSの摘み取りの意味を教えてください')).toBe('knowledge');
  });

  it('思考支援の依頼は thinking', () => {
    expect(classifyMessage('この段取りについてどう思いますか')).toBe('thinking');
    expect(classifyMessage('なぜこの順番で進めるのですか')).toBe('thinking');
    expect(classifyMessage('この業務を自分の日常に例えてほしい')).toBe('thinking');
  });

  it('分類できないメッセージは knowledge に倒す', () => {
    expect(classifyMessage('在庫連携のバッチ処理の仕様')).toBe('knowledge');
  });

  it('カテゴリとモデル階層のマッピング', () => {
    expect(tierForCategory('routine')).toBe('flash-lite');
    expect(tierForCategory('knowledge')).toBe('flash');
    expect(tierForCategory('thinking')).toBe('pro');
  });
});

describe('looksLikeCompletionReport', () => {
  it('完了申告を検知する', () => {
    expect(looksLikeCompletionReport('A社の見積もり作成、終わりました')).toBe(true);
    expect(looksLikeCompletionReport('店頭の在庫調整が完了しました')).toBe(true);
  });

  it('長文や通常の質問は完了申告としない', () => {
    expect(looksLikeCompletionReport('種まきリストとは?')).toBe(false);
    expect(
      looksLikeCompletionReport(
        'これは長い報告文です。'.repeat(20) + '最後に完了しました と書いても対象外',
      ),
    ).toBe(false);
  });
});
