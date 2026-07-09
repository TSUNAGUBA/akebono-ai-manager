import type { ModelTier } from './vertex.js';

/**
 * リクエスト分類(要件 6.5 モデルルーティング方針)。
 * 分類自体はルールベース(キーワード+コンテキスト種別)で行い、分類コストを最小化する。
 *
 *   routine    … 定型(挨拶、進捗確認、確認応答)          → flash-lite
 *   knowledge  … 知識回答(RAG 参照のドメイン解説)        → flash
 *   thinking   … 思考支援(仮説壁打ち、例え話、差分分析)  → pro
 */
export type RequestCategory = 'routine' | 'knowledge' | 'thinking';

export type DialogueContext =
  | 'morning_checkin'
  | 'completion_review'
  | 'adhoc_qa'
  | 'none';

const THINKING_PATTERNS: RegExp[] = [
  /仮説/,
  /例え(る|話|て)/,
  /たとえ(る|話|て)/,
  /どう(思|考え)/,
  /なぜ/,
  /どうして/,
  /どうすれば/,
  /(比較|判断|悩ん|迷っ)/,
  /振り返り/,
];

const KNOWLEDGE_PATTERNS: RegExp[] = [
  /とは[??]?\s*$/,
  /(教えて|知りたい|わからない|分からない)/,
  /(意味|用語|違い)/,
  /[??]\s*$/,
];

const ROUTINE_PATTERNS: RegExp[] = [
  /^(おはよう|おは|こんにちは|こんばんは|お疲れ|おつかれ)/,
  /^(はい|いいえ|OK|ok|了解|りょうかい|わかりました|分かりました|ありがとう)/,
  /^(終わりました|完了しました|できました)$/,
];

/**
 * メッセージをカテゴリに分類する。
 * 朝夕の対話コンテキスト内は常に思考支援(仮説形成の促し)として扱う。
 */
export function classifyMessage(text: string, context: DialogueContext = 'none'): RequestCategory {
  if (context === 'morning_checkin' || context === 'completion_review') {
    return 'thinking';
  }
  const trimmed = text.trim();
  if (trimmed.length <= 30 && ROUTINE_PATTERNS.some((p) => p.test(trimmed))) {
    return 'routine';
  }
  if (THINKING_PATTERNS.some((p) => p.test(trimmed))) {
    return 'thinking';
  }
  if (KNOWLEDGE_PATTERNS.some((p) => p.test(trimmed))) {
    return 'knowledge';
  }
  // 既定: 業務ドメインの質問である可能性が高いため知識回答として扱う
  return 'knowledge';
}

export function tierForCategory(category: RequestCategory): ModelTier {
  switch (category) {
    case 'routine':
      return 'flash-lite';
    case 'knowledge':
      return 'flash';
    case 'thinking':
      return 'pro';
  }
}

/** タスク完了の申告らしいメッセージか(夕の完了時レビューのトリガー)。 */
const COMPLETION_PATTERNS: RegExp[] = [
  /(終わ(った|りました)|完了(した|しました)?|できました|終えました|片付きました)/,
  /(done|Done|DONE)$/,
];

export function looksLikeCompletionReport(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 120) return false;
  return COMPLETION_PATTERNS.some((p) => p.test(trimmed));
}
