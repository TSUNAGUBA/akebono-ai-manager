import {
  ADHOC_QA_INSTRUCTION,
  ADHOC_QA_RESPONSE_SCHEMA,
  classifyMessage,
  EVENING_DIALOGUE_INSTRUCTION,
  EVENING_RESPONSE_SCHEMA,
  generateJson,
  jstDateString,
  logger,
  MORNING_DIALOGUE_INSTRUCTION,
  MORNING_RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  tierForCategory,
  type ChatAppMessage,
  type ChatTurn,
  looksLikeCompletionReport,
  suggestionCard,
} from '@ai-manager/shared';
import type pg from 'pg';
import type { OpsUser } from '../auth.js';
import type { ChatEvent } from '../chat-event.js';
import { messageText } from '../chat-event.js';
import {
  appendTurns,
  createDialogue,
  findMorningDialogue,
  findOpenDialogue,
  nowTurn,
  openTasksSummary,
  type DialogueRow,
  type DialogueTurn,
} from '../services/dialogues.js';
import { raiseEscalation } from '../services/escalations.js';
import {
  attachReason,
  createSuggestion,
  findAwaitingReason,
} from '../services/suggestions.js';
import { formatKnowledgeContext, searchAnalogies, searchKnowledge } from '../services/rag.js';
import {
  identifyTargetCustomer,
  resolveKnowledgeScope,
  scopeFallbackMode,
} from '../services/knowledge-scope.js';

const MAX_CONTEXT_TURNS = 12;

/** 対話ターンを LLM のメッセージ形式に変換する。 */
function turnsToMessages(turns: DialogueTurn[], latestUserText: string): ChatTurn[] {
  const history = turns
    .slice(-MAX_CONTEXT_TURNS)
    .map<ChatTurn>((t) => ({ role: t.role === 'ai' ? 'model' : 'user', text: t.content }));
  return [...history, { role: 'user', text: latestUserText }];
}

interface MorningLlmResponse {
  reply: string;
  hypothesis_complete: boolean;
  hypothesis?: {
    position: string;
    success_criteria: string;
    expected_obstacles: string;
    ai_assisted: boolean;
  };
}

/** 朝の問答の継続: 仮説形成の壁打ち。仮説が揃ったら hypothesis を確定する。 */
async function continueMorningDialogue(
  pool: pg.Pool,
  user: OpsUser,
  dialogue: DialogueRow,
  text: string,
): Promise<ChatAppMessage> {
  const tasks = await openTasksSummary(pool, user.user_id);
  const { value, result } = await generateJson<MorningLlmResponse>({
    tier: 'pro',
    system: `${SYSTEM_PROMPT}\n\n${MORNING_DIALOGUE_INSTRUCTION}\n\n## 本人のタスク状況\n${tasks}`,
    messages: turnsToMessages(dialogue.turns, text),
    responseSchema: MORNING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  });

  const update =
    value.hypothesis_complete && value.hypothesis !== undefined
      ? { hypothesis: value.hypothesis as unknown as Record<string, unknown> }
      : {};
  await appendTurns(pool, dialogue, [nowTurn('user', text), nowTurn('ai', value.reply)], {
    ...update,
    modelUsed: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });
  return { text: value.reply };
}

interface EveningLlmResponse {
  reply: string;
  review_complete: boolean;
  review?: {
    actual_outcome: string;
    gap_analysis: string;
    next_change: string;
    gap_category: 'none' | 'minor' | 'major' | 'opposite';
  };
  next_action_suggestion?: string;
}

/** 夕の振り返りの継続(または開始)。review が揃ったら確定し、次アクション提案があればカードを付ける。 */
async function continueEveningDialogue(
  pool: pg.Pool,
  user: OpsUser,
  dialogue: DialogueRow,
  text: string,
): Promise<ChatAppMessage> {
  const morning = await findMorningDialogue(pool, user.user_id, jstDateString());
  const hypothesisContext =
    morning?.hypothesis == null
      ? '(今朝の仮説は記録されていません)'
      : JSON.stringify(morning.hypothesis);

  const { value, result } = await generateJson<EveningLlmResponse>({
    tier: 'pro',
    system: `${SYSTEM_PROMPT}\n\n${EVENING_DIALOGUE_INSTRUCTION}\n\n## 今朝の仮説\n${hypothesisContext}`,
    messages: turnsToMessages(dialogue.turns, text),
    responseSchema: EVENING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  });

  const update =
    value.review_complete && value.review !== undefined
      ? { review: value.review as unknown as Record<string, unknown> }
      : {};
  await appendTurns(pool, dialogue, [nowTurn('user', text), nowTurn('ai', value.reply)], {
    ...update,
    modelUsed: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });

  const message: ChatAppMessage = { text: value.reply };
  if (value.review_complete && value.next_action_suggestion !== undefined && value.next_action_suggestion !== '') {
    // 提案の記録・カード付与は補助処理: 失敗しても振り返りの完了応答は返す
    try {
      const suggestionId = await createSuggestion(pool, {
        userId: user.user_id,
        content: value.next_action_suggestion,
        category: 'next_action',
        dialogueId: dialogue.dialogue_id,
        taskId: dialogue.task_id,
      });
      message.cardsV2 = [suggestionCard(suggestionId, value.next_action_suggestion)];
    } catch (err) {
      logger.error('次アクション提案の記録に失敗しました(処理は継続)', err);
    }
  }
  return message;
}

/** 夕の振り返りを開始する(完了申告を検知したとき)。 */
async function startEveningDialogue(
  pool: pg.Pool,
  user: OpsUser,
  text: string,
): Promise<ChatAppMessage> {
  const morning = await findMorningDialogue(pool, user.user_id, jstDateString());
  const hypothesisContext =
    morning?.hypothesis == null
      ? '(今朝の仮説は記録されていません)'
      : JSON.stringify(morning.hypothesis);

  const { value, result } = await generateJson<EveningLlmResponse>({
    tier: 'pro',
    system: `${SYSTEM_PROMPT}\n\n${EVENING_DIALOGUE_INSTRUCTION}\n\n## 今朝の仮説\n${hypothesisContext}`,
    messages: [{ role: 'user', text }],
    responseSchema: EVENING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  });

  await createDialogue(pool, {
    userId: user.user_id,
    dialogueType: 'completion_review',
    turns: [nowTurn('user', text), nowTurn('ai', value.reply)],
    taskId: morning?.task_id ?? null,
    projectId: morning?.project_id ?? null,
    modelUsed: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });
  return { text: value.reply };
}

interface QaLlmResponse {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
}

/** 随時 QA: RAG で文脈を供給して回答する。確信が持てなければエスカレーション。 */
async function answerAdhocQuestion(
  pool: pg.Pool,
  user: OpsUser,
  text: string,
): Promise<ChatAppMessage> {
  const category = classifyMessage(text);
  const tier = tierForCategory(category);

  // ナレッジスコープ(要件 v0.3 §4): 対象顧客を特定できたら 1 ホップの到達可能集合で絞り、
  // 特定できなければ既定で顧客固有を除外する(誤混入防止)。例え話は共通ナレッジのため対象外
  const targetCustomerId = await identifyTargetCustomer(pool, text);
  const scope =
    targetCustomerId !== undefined
      ? await resolveKnowledgeScope(pool, targetCustomerId)
      : scopeFallbackMode() === 'all'
        ? undefined
        : ('exclude-customer' as const);

  const [chunks, analogies] = await Promise.all([
    searchKnowledge(pool, text, {
      docTypes: ['customer_profile', 'glossary', 'domain_ops', 'decision_rules'],
      limit: 5,
      scope,
    }),
    /例え|たとえ/.test(text) ? searchAnalogies(pool, text) : Promise.resolve([]),
  ]);

  const analogyBlock =
    analogies.length === 0
      ? ''
      : `\n\n## 例え話の参考(few-shot)\n${formatKnowledgeContext(analogies)}`;

  const { value, result } = await generateJson<QaLlmResponse>({
    tier,
    system: `${SYSTEM_PROMPT}\n\n${ADHOC_QA_INSTRUCTION}\n\n## 参考情報\n${formatKnowledgeContext(chunks)}${analogyBlock}`,
    messages: [{ role: 'user', text }],
    responseSchema: ADHOC_QA_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  });

  await createDialogue(pool, {
    userId: user.user_id,
    dialogueType: 'adhoc_qa',
    turns: [nowTurn('user', text), nowTurn('ai', value.answer)],
    modelUsed: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });

  if (value.confidence === 'low') {
    await raiseEscalation(pool, {
      reason: 'low_confidence',
      context: `質問(${user.display_name}): ${text}\nAI回答(確信度低): ${value.answer}`,
      relatedUserId: user.user_id,
    });
    return {
      text: `${value.answer}\n\nこの回答には確信が持てないため、管理者にも確認を依頼しました。`,
    };
  }
  return { text: value.answer };
}

/**
 * MESSAGE イベントのハンドラ。
 * 優先順: 提案理由の受領 → 進行中の朝夕対話の継続 → 完了申告の検知 → 随時 QA
 */
export async function handleMessage(
  pool: pg.Pool,
  event: ChatEvent,
  user: OpsUser,
): Promise<ChatAppMessage> {
  const text = messageText(event);
  if (text === '') {
    return {
      text: 'メッセージが空でした。質問や相談があればそのまま話しかけてください。',
    };
  }

  // 提案への採否直後のフリーテキストは「理由」として記録する
  const awaiting = await findAwaitingReason(pool, user.user_id);
  if (awaiting !== undefined && text.length <= 300 && !/[??]/.test(text)) {
    await attachReason(pool, awaiting.suggestion_id, text);
    return {
      text: '理由を記録しました。あなたの判断はチームの知恵として蓄積されます。ありがとうございます。',
    };
  }

  const open = await findOpenDialogue(pool, user.user_id, jstDateString());
  if (open !== undefined) {
    return open.dialogue_type === 'morning_checkin'
      ? continueMorningDialogue(pool, user, open, text)
      : continueEveningDialogue(pool, user, open, text);
  }

  if (looksLikeCompletionReport(text)) {
    return startEveningDialogue(pool, user, text);
  }

  return answerAdhocQuestion(pool, user, text);
}
