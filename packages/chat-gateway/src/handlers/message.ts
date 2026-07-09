import {
  ADHOC_QA_INSTRUCTION,
  ADHOC_QA_RESPONSE_SCHEMA,
  classifyMessage,
  detectTaskInstruction,
  EVENING_DIALOGUE_INSTRUCTION,
  EVENING_RESPONSE_SCHEMA,
  generateJson,
  jstDateString,
  logger,
  MORNING_DIALOGUE_INSTRUCTION,
  MORNING_RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  TASK_COMPLETION_MATCH_INSTRUCTION,
  TASK_COMPLETION_MATCH_SCHEMA,
  TASK_DECOMPOSITION_INSTRUCTION,
  TASK_DECOMPOSITION_SCHEMA,
  TASK_INSTRUCTION_CLASSIFY_INSTRUCTION,
  TASK_INSTRUCTION_CLASSIFY_SCHEMA,
  taskApprovalCard,
  taskDoneConfirmCard,
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
import {
  findAwaitingResolution,
  raiseEscalation,
  recordResolution,
  refluxResolutionToKnowledge,
} from '../services/escalations.js';
import {
  attachReason,
  createSuggestion,
  findAwaitingReason,
} from '../services/suggestions.js';
import {
  createProposedTask,
  formatOpenTasks,
  listActiveProjects,
  listActiveUsers,
  listOpenTasks,
  startTaskFromDialogue,
  validateDecomposition,
  type TaskDecompositionResponse,
} from '../services/tasks.js';
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
  started_task_id?: string;
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

  // 「今日やる」と明確に言及されたタスクの approved → in_progress 遷移(M3)。
  // 補助処理のため失敗しても対話応答は返す。WHERE 条件(本人+approved)により非破壊・冪等。
  if (value.started_task_id !== undefined && /^\d+$/.test(value.started_task_id)) {
    try {
      const started = await startTaskFromDialogue(pool, value.started_task_id, user.user_id);
      if (started !== undefined) {
        logger.info('朝の対話からタスクを着手中に更新しました', {
          taskId: started.task_id,
          userId: user.user_id,
        });
      }
    } catch (err) {
      logger.error('対話からのタスク着手更新に失敗しました(処理は継続)', err, {
        taskId: value.started_task_id,
      });
    }
  }
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

// ── タスクオーケストレーション(M3)──────────────────────────────

/** 曖昧なメッセージがタスク指示かを flash-lite で分類する。失敗時は false(QA に倒す)。 */
async function classifyTaskInstruction(text: string): Promise<boolean> {
  try {
    const { value } = await generateJson<{ is_task_instruction: boolean }>({
      tier: 'flash-lite',
      system: `${SYSTEM_PROMPT}\n\n${TASK_INSTRUCTION_CLASSIFY_INSTRUCTION}`,
      messages: [{ role: 'user', text }],
      responseSchema: TASK_INSTRUCTION_CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
    });
    return value.is_task_instruction;
  } catch (err) {
    logger.error('タスク指示の分類に失敗しました(QA として処理を継続)', err);
    return false;
  }
}

/** 管理者のメッセージがタスク指示か(ルールベース先行、曖昧な場合のみ LLM)。 */
async function isTaskInstruction(user: OpsUser, text: string): Promise<boolean> {
  if (user.role !== 'admin') return false;
  const signal = detectTaskInstruction(text);
  if (signal === 'yes') return true;
  if (signal === 'ambiguous') return classifyTaskInstruction(text);
  return false;
}

/**
 * タスク指示の処理(M3): pro で分解・担当案・期限案を生成し、
 * ops.tasks に status='proposed' で登録して管理者へ承認カードを返す。
 */
async function handleTaskInstruction(
  pool: pg.Pool,
  user: OpsUser,
  text: string,
): Promise<ChatAppMessage> {
  const [users, projects] = await Promise.all([listActiveUsers(pool), listActiveProjects(pool)]);
  const membersBlock = users
    .map((u) => `- user_id: ${u.user_id} / 名前: ${u.display_name} / ロール: ${u.role}`)
    .join('\n');
  const projectsBlock =
    projects.length === 0
      ? '(進行中のプロジェクトはありません)'
      : projects.map((p) => `- project_id: ${p.project_id} / 名前: ${p.name}`).join('\n');

  let value: TaskDecompositionResponse;
  let result: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  try {
    ({ value, result } = await generateJson<TaskDecompositionResponse>({
      tier: 'pro',
      system: [
        SYSTEM_PROMPT,
        '',
        TASK_DECOMPOSITION_INSTRUCTION,
        '',
        `## 今日の日付\n${jstDateString()}`,
        '',
        `## メンバー一覧(active)\n${membersBlock}`,
        '',
        `## プロジェクト一覧\n${projectsBlock}`,
      ].join('\n'),
      messages: [{ role: 'user', text }],
      responseSchema: TASK_DECOMPOSITION_SCHEMA as unknown as Record<string, unknown>,
    }));
  } catch (err) {
    logger.error('タスク分解の生成に失敗しました', err);
    return {
      text: 'タスクの分解に失敗しました。お手数ですが、もう一度指示を送ってください。',
    };
  }

  const validated = validateDecomposition(value, users, projects);
  if (!validated.ok) {
    return {
      text: `タスク案を確定できませんでした(${validated.reason})。担当者と内容がわかる形で指示を出し直してください。`,
    };
  }
  const d = validated.value;

  const taskId = await createProposedTask(pool, {
    requesterId: user.user_id,
    decomposition: d,
  });

  // 指示のやり取りを対話ログ(task_instruction)として記録する(補助処理: 失敗しても応答は返す)
  const cardSummary = `タスク案「${d.title}」を作成しました(担当案: ${d.assigneeId} / 期限案: ${d.dueDate ?? '未定'})`;
  try {
    await createDialogue(pool, {
      userId: user.user_id,
      dialogueType: 'task_instruction',
      turns: [nowTurn('user', text), nowTurn('ai', cardSummary)],
      taskId,
      projectId: d.projectId,
      modelUsed: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });
  } catch (err) {
    logger.error('タスク指示の対話ログ記録に失敗しました(処理は継続)', err, { taskId });
  }

  const assigneeName =
    users.find((u) => u.user_id === d.assigneeId)?.display_name ?? d.assigneeId;
  const projectName = projects.find((p) => p.project_id === d.projectId)?.name;
  return {
    text: 'タスク案を作成しました。内容を確認してください。',
    cardsV2: [
      taskApprovalCard(taskId, {
        title: d.title,
        assigneeName,
        ...(d.dueDate === null ? {} : { dueDate: d.dueDate }),
        ...(d.estimatedHours === null ? {} : { estimatedHours: d.estimatedHours }),
        ...(projectName === undefined ? {} : { projectName }),
        subtasks: d.subtasks.map((s) => s.title),
        ...(d.expectedOutcome === null ? {} : { expectedOutcome: d.expectedOutcome }),
      }),
    ],
  };
}

/**
 * 完了申告と本人の未完了タスクを flash で照合し、確信度が高い場合のみ
 * 完了確認カードを応答に付与する(M3: 対話からの進捗更新)。
 * 補助処理のため、失敗しても夕の振り返り応答はそのまま返す。
 */
async function attachTaskDoneConfirmation(
  pool: pg.Pool,
  user: OpsUser,
  text: string,
  message: ChatAppMessage,
): Promise<void> {
  try {
    const tasks = await listOpenTasks(pool, user.user_id);
    if (tasks.length === 0) return;

    const { value } = await generateJson<{
      matched: boolean;
      task_id?: string;
      confidence?: 'high' | 'medium' | 'low';
    }>({
      tier: 'flash',
      system: `${SYSTEM_PROMPT}\n\n${TASK_COMPLETION_MATCH_INSTRUCTION}\n\n## 本人のタスク一覧\n${formatOpenTasks(tasks)}`,
      messages: [{ role: 'user', text }],
      responseSchema: TASK_COMPLETION_MATCH_SCHEMA as unknown as Record<string, unknown>,
    });

    if (!value.matched || value.confidence !== 'high' || value.task_id === undefined) return;
    const matchedTask = tasks.find((t) => t.task_id === value.task_id);
    if (matchedTask === undefined) return; // LLM がタスク一覧にない ID を返した場合は無視

    message.cardsV2 = [
      ...(message.cardsV2 ?? []),
      taskDoneConfirmCard(matchedTask.task_id, matchedTask.title),
    ];
  } catch (err) {
    logger.error('完了申告とタスクの照合に失敗しました(処理は継続)', err);
  }
}

// ── 裁定のナレッジ還流(M6)──────────────────────────────────────

/**
 * 「裁定を記録」押下後の管理者メッセージを裁定として保存し、ナレッジへ還流する。
 * SoT(ops.escalations)への保存を先に行い、キャッシュ(rag)への還流失敗は
 * 裁定自体を巻き戻さない(knowledge_reflected=false のまま再還流可能)。
 */
async function recordEscalationResolution(
  pool: pg.Pool,
  user: OpsUser,
  escalationId: string,
  text: string,
): Promise<ChatAppMessage> {
  const resolved = await recordResolution(pool, escalationId, user.user_id, text);
  if (resolved === undefined) {
    return { text: 'このエスカレーションは既に裁定済みのため、上書きしませんでした。' };
  }
  try {
    await refluxResolutionToKnowledge(pool, resolved);
    return {
      text: '裁定を記録し、判断基準ナレッジへ還流しました。今後の類似ケースで AI が参照します。',
    };
  } catch (err) {
    logger.error('裁定のナレッジ還流に失敗しました(裁定の記録は保持)', err, {
      escalationId,
    });
    return {
      text: '裁定は記録しましたが、ナレッジへの反映に失敗しました。エスカレーションカードの「裁定を記録」を再度押すと再反映できます。',
    };
  }
}

/**
 * MESSAGE イベントのハンドラ。
 * 優先順: 裁定の受領(管理者) → 提案理由の受領 → タスク指示の検知(管理者)
 *        → 進行中の朝夕対話の継続 → 完了申告の検知 → 随時 QA
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

  // 「裁定を記録」ボタン押下直後の管理者メッセージは裁定として記録する(M6)
  if (user.role === 'admin') {
    const awaitingEscalation = await findAwaitingResolution(pool, user.user_id);
    if (awaitingEscalation !== undefined) {
      return recordEscalationResolution(pool, user, awaitingEscalation.escalation_id, text);
    }
  }

  // 提案への採否直後のフリーテキストは「理由」として記録する
  const awaiting = await findAwaitingReason(pool, user.user_id);
  if (awaiting !== undefined && text.length <= 300 && !/[??]/.test(text)) {
    await attachReason(pool, awaiting.suggestion_id, text);
    return {
      text: '理由を記録しました。あなたの判断はチームの知恵として蓄積されます。ありがとうございます。',
    };
  }

  // 管理者のタスク指示(M3)。ルールベース先行+曖昧な場合のみ flash-lite で分類
  if (await isTaskInstruction(user, text)) {
    return handleTaskInstruction(pool, user, text);
  }

  const open = await findOpenDialogue(pool, user.user_id, jstDateString());
  if (open !== undefined) {
    return open.dialogue_type === 'morning_checkin'
      ? continueMorningDialogue(pool, user, open, text)
      : continueEveningDialogue(pool, user, open, text);
  }

  if (looksLikeCompletionReport(text)) {
    const message = await startEveningDialogue(pool, user, text);
    // 未完了タスクとの照合(確度が高い場合のみ完了確認カードを付与)
    await attachTaskDoneConfirmation(pool, user, text, message);
    return message;
  }

  return answerAdhocQuestion(pool, user, text);
}
