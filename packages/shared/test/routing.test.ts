import { describe, expect, it } from 'vitest';
import {
  classifyMessage,
  detectTaskInstruction,
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

describe('detectTaskInstruction(M3 タスク指示のルールベース判定)', () => {
  it('「タスク:」「依頼:」プレフィックスのみ yes に確定する(全角・半角コロン)', () => {
    expect(detectTaskInstruction('タスク: A社の見積もり資料を作成')).toBe('yes');
    expect(detectTaskInstruction('タスク:A社の見積もり資料を作成')).toBe('yes');
    expect(detectTaskInstruction('依頼: 在庫レポートの更新')).toBe('yes');
  });

  it('担当者+期限+依頼動詞が揃っても yes に確定せず ambiguous(過検知防止で LLM 分類へ)', () => {
    expect(
      detectTaskInstruction('田中さんに金曜までにA社の見積もりを作成してもらうようお願いします'),
    ).toBe('ambiguous');
    expect(detectTaskInstruction('佐藤さんに今週中にWMSの検証をやってもらってください')).toBe(
      'ambiguous',
    );
  });

  it('疑問文は ambiguous(相談の可能性)', () => {
    expect(
      detectTaskInstruction('田中さんに金曜までに見積もり作成をお願いするべきですか?'),
    ).toBe('ambiguous');
  });

  it('シグナルが部分的なら ambiguous(LLM 分類へ)', () => {
    expect(detectTaskInstruction('田中さんにこの件をお願いしたい')).toBe('ambiguous');
    expect(detectTaskInstruction('今週中に在庫レポートをまとめてほしい')).toBe('ambiguous');
  });

  it('自分主語の宣言(「〜します」「〜しておきます」)は no(過検知の回帰ケース)', () => {
    expect(detectTaskInstruction('山田さんに今日中に対応しておきます')).not.toBe('yes');
    expect(detectTaskInstruction('山田さんに今日中に対応しておきます')).toBe('no');
    expect(detectTaskInstruction('A社の見積もりは私が今日中に作成します')).toBe('no');
    expect(detectTaskInstruction('明日までに資料をまとめて共有します')).toBe('no');
  });

  it('依頼先マーカー(お願い・ください等)があれば宣言扱いにしない', () => {
    expect(detectTaskInstruction('田中さんに金曜までに対応してもらうようお願いします')).toBe(
      'ambiguous',
    );
  });

  it('通常の質問・報告は no', () => {
    expect(detectTaskInstruction('種まきリストとは?')).toBe('no');
    expect(detectTaskInstruction('A社の対応が完了しました')).toBe('no');
    expect(detectTaskInstruction('おはようございます')).toBe('no');
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
