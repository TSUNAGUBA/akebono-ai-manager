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

// ── タスク指示の検知(M3)─────────────────────────────────────────
// 管理者のメッセージが「メンバーへのタスク指示」かをルールベースで先行判定する。
// 確実なパターンのみ 'yes' とし、部分的なシグナルは 'ambiguous' として
// flash-lite での分類(TASK_INSTRUCTION_CLASSIFY_*)に委ねる。

export type TaskInstructionSignal = 'yes' | 'ambiguous' | 'no';

/** 「タスク:」「依頼:」プレフィックス(全角・半角コロン両対応)。 */
const TASK_PREFIX_PATTERN = /^(タスク|依頼)\s*[::]/;

/** 担当者への割り当て表現(「〜さんに」等)。 */
const ASSIGNEE_PATTERN = /(さん|くん|君|氏)に/;

/** 期限の表現(「〜までに」等)。 */
const DEADLINE_PATTERN = /(までに|期限|締め切り|締切|〆切|今日中|本日中|今週中|来週中|月末まで)/;

/** 依頼の動詞表現。 */
const REQUEST_VERB_PATTERN =
  /(お願い|依頼|頼(み|んで)|やって|進めて|対応して|作成して|作って|準備して|まとめて|調整して|確認して|共有して|送って|渡して|任せ|アサイン|振って)/;

/**
 * タスク指示らしさのルールベース判定(M3)。
 * - 'yes':       プレフィックス、または 担当者+期限+依頼動詞 が揃った平叙文
 * - 'ambiguous': 担当者または期限+依頼動詞(疑問文を含む)→ LLM 分類へ
 * - 'no':        それ以外(通常の QA・対話として処理)
 */
export function detectTaskInstruction(text: string): TaskInstructionSignal {
  const trimmed = text.trim();
  if (TASK_PREFIX_PATTERN.test(trimmed)) return 'yes';

  const hasAssignee = ASSIGNEE_PATTERN.test(trimmed);
  const hasDeadline = DEADLINE_PATTERN.test(trimmed);
  const hasRequestVerb = REQUEST_VERB_PATTERN.test(trimmed);
  const isQuestion = /[??]\s*$/.test(trimmed);

  if (hasAssignee && hasDeadline && hasRequestVerb) {
    // 疑問文(「〜してもらうべきですか?」等)は相談の可能性があるため LLM に委ねる
    return isQuestion ? 'ambiguous' : 'yes';
  }
  if ((hasAssignee || hasDeadline) && hasRequestVerb) return 'ambiguous';
  return 'no';
}
