import {
  ADHOC_CHECKIN_DIALOGUE_INSTRUCTION,
  ADHOC_QA_INSTRUCTION,
  ADHOC_QA_RESPONSE_SCHEMA,
  classifyMessage,
  detectTaskInstruction,
  EVENING_DIALOGUE_INSTRUCTION,
  EVENING_RESPONSE_SCHEMA,
  generateContent,
  generateJson,
  jstDateString,
  logger,
  query,
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
  escalationRefluxRetryCard,
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
  cancelResolutionRecording,
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
import { fetchCustomerContext } from '../services/customer-context.js';

const MAX_CONTEXT_TURNS = 12;

/** 対話継続の応答生成に失敗したときのフォールバック文言(v0.9 §5)。 */
const DIALOGUE_FALLBACK_REPLY =
  'すみません、応答の生成に一時的に失敗しました。いただいた返信は記録しています。少し時間をおいて、続きをそのまま送ってください。';

/**
 * 対話継続(朝・夕・状況確認)の応答生成が失敗したとき、ユーザーの返信ターンを
 * フォールバック応答とともに保存した上で、定型文で応答する(v0.9 §5)。
 * 配信側(morning/adhoc-checkin ジョブ)には定型文フォールバックがあるのに、
 * 継続側は例外がそのまま伝播して汎用エラーになり、返信テキストが記録されず
 * 失われていた(記録系データの保護 — 開発原則 2 の観点で改修)。
 * AI 側のフォールバックターンも保存し、対話履歴の user/model の交互性を保つ。
 * 保存まで失敗した場合のみ例外を伝播させる(返信が記録できておらず、
 * 汎用エラー文言でユーザーへ再送を促す必要があるため)。
 */
async function recoverDialogueContinuation(
  pool: pg.Pool,
  dialogue: DialogueRow,
  text: string,
  err: unknown,
): Promise<ChatAppMessage> {
  // 既知の制約: adhoc_checkin の最終往復(turns = 上限-2)で失敗した場合、フォールバックの
  // 2 ターンで上限に達して対話がクローズし、次のメッセージは QA として処理される
  // (返信は保存済みでデータ消失はない。v0.9 §5.1 に明記した許容トレードオフ)
  logger.error('対話継続の応答生成に失敗しました(返信ターンを保存してフォールバック)', err, {
    dialogueId: dialogue.dialogue_id,
    dialogueType: dialogue.dialogue_type,
  });
  await appendTurns(pool, dialogue, [
    nowTurn('user', text),
    nowTurn('ai', DIALOGUE_FALLBACK_REPLY),
  ]);
  return { text: DIALOGUE_FALLBACK_REPLY };
}

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

/**
 * LLM が返すタスク ID 表現('[ID:7]' / 'ID:7' / '7' のいずれの形式でも)から
 * 数値部分を抽出する。抽出できなければ undefined(呼び出し側でスキップ)。
 */
function extractTaskId(raw: string): string | undefined {
  const match = /^\s*\[?\s*(?:ID\s*[::]\s*)?(\d+)\s*\]?\s*$/i.exec(raw);
  return match?.[1];
}

/** 朝の問答の継続: 仮説形成の壁打ち。仮説が揃ったら hypothesis を確定する。 */
async function continueMorningDialogue(
  pool: pg.Pool,
  user: OpsUser,
  dialogue: DialogueRow,
  text: string,
): Promise<ChatAppMessage> {
  // タスク状況は補助文脈のため、取得失敗でも返信の処理を止めない(v0.9 §5・原則4)
  const tasks = await openTasksSummary(pool, user.user_id).catch((err: unknown) => {
    logger.error('タスク状況の取得に失敗しました(タスク文脈なしで継続)', err);
    return '(タスク状況を取得できませんでした)';
  });
  let value: MorningLlmResponse;
  let result: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  try {
    ({ value, result } = await generateJson<MorningLlmResponse>({
      tier: 'pro',
      system: `${SYSTEM_PROMPT}\n\n${MORNING_DIALOGUE_INSTRUCTION}\n\n## 本人のタスク状況\n${tasks}`,
      messages: turnsToMessages(dialogue.turns, text),
      responseSchema: MORNING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    }));
  } catch (err) {
    return recoverDialogueContinuation(pool, dialogue, text, err);
  }

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
  if (value.started_task_id !== undefined && value.started_task_id !== '') {
    const startedTaskId = extractTaskId(value.started_task_id);
    if (startedTaskId === undefined) {
      logger.debug('started_task_id からタスク ID を抽出できないためスキップします', {
        startedTaskId: value.started_task_id,
      });
    } else {
      try {
        const started = await startTaskFromDialogue(pool, startedTaskId, user.user_id);
        if (started !== undefined) {
          logger.info('朝の対話からタスクを着手中に更新しました', {
            taskId: started.task_id,
            userId: user.user_id,
          });
        }
      } catch (err) {
        logger.error('対話からのタスク着手更新に失敗しました(処理は継続)', err, {
          taskId: startedTaskId,
        });
      }
    }
  }
  return { text: value.reply };
}

/**
 * 状況確認(管理者発火・v0.5)の継続: 仮説形成・構造化出力は要求しない軽量な共感的深掘り。
 * 締め(2〜3往復)はプロンプトの指示+findOpenDialogue のターン数上限で自然にクローズする。
 */
async function continueAdhocCheckinDialogue(
  pool: pg.Pool,
  user: OpsUser,
  dialogue: DialogueRow,
  text: string,
): Promise<ChatAppMessage> {
  // タスク状況は補助文脈のため、取得失敗でも返信の処理を止めない(v0.9 §5・原則4)
  const tasks = await openTasksSummary(pool, user.user_id).catch((err: unknown) => {
    logger.error('タスク状況の取得に失敗しました(タスク文脈なしで継続)', err);
    return '(タスク状況を取得できませんでした)';
  });
  // 構造化抽出が不要な軽量対話のため、pro ではなく flash のプレーンテキスト生成で応答する
  let result: Awaited<ReturnType<typeof generateContent>>;
  try {
    result = await generateContent({
      tier: 'flash',
      system: `${SYSTEM_PROMPT}\n\n${ADHOC_CHECKIN_DIALOGUE_INSTRUCTION}\n\n## 本人のタスク状況\n${tasks}`,
      messages: turnsToMessages(dialogue.turns, text),
    });
  } catch (err) {
    return recoverDialogueContinuation(pool, dialogue, text, err);
  }

  await appendTurns(pool, dialogue, [nowTurn('user', text), nowTurn('ai', result.text)], {
    modelUsed: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });
  return { text: result.text };
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
  // 今朝の対話は補助文脈のため、取得失敗でも処理を止めない(v0.9 §5・原則4)
  const morning = await findMorningDialogue(pool, user.user_id, jstDateString()).catch(
    (err: unknown) => {
      logger.error('今朝の対話の取得に失敗しました(仮説の文脈なしで継続)', err);
      return undefined;
    },
  );
  const hypothesisContext =
    morning?.hypothesis == null
      ? '(今朝の仮説は記録されていません)'
      : JSON.stringify(morning.hypothesis);

  let value: EveningLlmResponse;
  let result: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  try {
    ({ value, result } = await generateJson<EveningLlmResponse>({
      tier: 'pro',
      system: `${SYSTEM_PROMPT}\n\n${EVENING_DIALOGUE_INSTRUCTION}\n\n## 今朝の仮説\n${hypothesisContext}`,
      messages: turnsToMessages(dialogue.turns, text),
      responseSchema: EVENING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    }));
  } catch (err) {
    return recoverDialogueContinuation(pool, dialogue, text, err);
  }

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
  // 今朝の対話は補助文脈のため、取得失敗でも処理を止めない(v0.9 §5・原則4)
  const morning = await findMorningDialogue(pool, user.user_id, jstDateString()).catch(
    (err: unknown) => {
      logger.error('今朝の対話の取得に失敗しました(仮説の文脈なしで継続)', err);
      return undefined;
    },
  );
  const hypothesisContext =
    morning?.hypothesis == null
      ? '(今朝の仮説は記録されていません)'
      : JSON.stringify(morning.hypothesis);

  let value: EveningLlmResponse;
  let result: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  try {
    ({ value, result } = await generateJson<EveningLlmResponse>({
      tier: 'pro',
      system: `${SYSTEM_PROMPT}\n\n${EVENING_DIALOGUE_INSTRUCTION}\n\n## 今朝の仮説\n${hypothesisContext}`,
      messages: [{ role: 'user', text }],
      responseSchema: EVENING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    }));
  } catch (err) {
    // 継続時(recoverDialogueContinuation)と同じ設計: 完了申告のテキストを失わない(v0.9 §5)。
    // open な completion_review として保存されるため、次のメッセージで振り返りを継続できる
    logger.error('夕の振り返りの応答生成に失敗しました(申告ターンを保存してフォールバック)', err, {
      userId: user.user_id,
    });
    await createDialogue(pool, {
      userId: user.user_id,
      dialogueType: 'completion_review',
      turns: [nowTurn('user', text), nowTurn('ai', DIALOGUE_FALLBACK_REPLY)],
      taskId: morning?.task_id ?? null,
      projectId: morning?.project_id ?? null,
    });
    return { text: DIALOGUE_FALLBACK_REPLY };
  }

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

/**
 * 対話文脈のプロジェクト顧客(v0.7 §4 の優先順②)を導出する:
 * 本人の直近の in_progress タスクが属するプロジェクトの顧客。
 * 質問文に顧客名の明示一致がない場合のフォールバックとして使われる。
 * 文脈顧客は補助情報のため、取得失敗は無視して従来動作(質問文からの特定のみ)に倒す。
 */
async function findContextCustomerId(pool: pg.Pool, userId: string): Promise<string | undefined> {
  try {
    const result = await query<{ customer_id: string | null }>(
      pool,
      `SELECT p.customer_id
         FROM ops.tasks t
         JOIN ops.projects p ON p.project_id = t.project_id
        WHERE t.assignee_id = $1 AND t.status = 'in_progress'
        ORDER BY t.updated_at DESC
        LIMIT 1`,
      [userId],
    );
    return result.rows[0]?.customer_id ?? undefined;
  } catch (err) {
    logger.error('文脈顧客の取得に失敗しました(質問文からの特定のみで継続)', err, { userId });
    return undefined;
  }
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
  // 優先順(v0.7 §4)①: 質問文の名称照合(明示的な言及を最優先) ②: 対話文脈のプロジェクト顧客
  const contextCustomerId = await findContextCustomerId(pool, user.user_id);
  const targetCustomerId = await identifyTargetCustomer(pool, text, contextCustomerId);

  // スコープ導出の失敗は QA を止めず、安全側(顧客固有の除外)に倒す(v0.9 §5・原則4)
  let scope: Awaited<ReturnType<typeof resolveKnowledgeScope>> | 'exclude-customer' | undefined;
  if (targetCustomerId !== undefined) {
    try {
      scope = await resolveKnowledgeScope(pool, targetCustomerId);
    } catch (err) {
      logger.error('ナレッジスコープの導出に失敗しました(顧客固有を除外して継続)', err, {
        targetCustomerId,
      });
      scope = 'exclude-customer';
    }
  } else {
    scope = scopeFallbackMode() === 'all' ? undefined : ('exclude-customer' as const);
  }

  // 顧客マスタ情報(v0.7 §3): 対象顧客の業界・顧客間関係を SoT(ops マスタ)から
  // 直接取得してプロンプトに供給する(取得失敗は非ブロッキングで undefined)。
  // ナレッジ検索(embedding 依存)の失敗も QA を止めず、参考情報なしで継続する(v0.9 §5)
  const [chunks, analogies, customerContext] = await Promise.all([
    searchKnowledge(pool, text, {
      docTypes: ['customer_profile', 'glossary', 'domain_ops', 'decision_rules'],
      limit: 5,
      scope,
    }).catch((err: unknown) => {
      logger.error('ナレッジ検索に失敗しました(参考情報なしで継続)', err);
      return [];
    }),
    /例え|たとえ/.test(text)
      ? searchAnalogies(pool, text).catch((err: unknown) => {
          logger.error('例え話の検索に失敗しました(few-shot なしで継続)', err);
          return [];
        })
      : Promise.resolve([]),
    targetCustomerId !== undefined
      ? fetchCustomerContext(pool, targetCustomerId)
      : Promise.resolve(undefined),
  ]);

  const customerContextBlock =
    customerContext === undefined ? '' : `\n\n## 顧客マスタ情報\n${customerContext}`;
  const analogyBlock =
    analogies.length === 0
      ? ''
      : `\n\n## 例え話の参考(few-shot)\n${formatKnowledgeContext(analogies)}`;

  const { value, result } = await generateJson<QaLlmResponse>({
    tier,
    system: `${SYSTEM_PROMPT}\n\n${ADHOC_QA_INSTRUCTION}${customerContextBlock}\n\n## 参考情報\n${formatKnowledgeContext(chunks)}${analogyBlock}`,
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
    // 対象顧客の特定結果を診断情報として残す(v0.9 §4: 「マスタ登録済みなのに未登録と
    // 回答される」事象の切り分け — 特定失敗ならエイリアス/名称登録、特定済みなら関係登録を疑う)
    const targetInfo =
      targetCustomerId ?? '(特定できず — 顧客マスタの名称・エイリアスと質問文が不一致の可能性)';
    await raiseEscalation(pool, {
      reason: 'low_confidence',
      context: `質問(${user.display_name}): ${text}\n対象顧客: ${targetInfo}\nAI回答(確信度低): ${value.answer}`,
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
    // 復旧経路: 「ナレッジ還流を再試行」ボタン付きカードを返す。
    // ボタンは card-action の再還流分岐(knowledge_reflected=false の間のみ有効・冪等)に到達する
    return {
      text: '裁定は記録しましたが、ナレッジへの反映に失敗しました。「ナレッジ還流を再試行」を押すと再反映できます。',
      cardsV2: [
        escalationRefluxRetryCard(escalationId, resolved.reason, resolved.resolution ?? text),
      ],
    };
  }
}

/** 裁定ゲートの中止ワード(「キャンセル」等)。 */
const RESOLUTION_CANCEL_PATTERN = /^(キャンセル|やめる|やめます|やめて|中止|取り消し|取消)[。..!!]?$/;

/** 裁定として記録するテキストの長さ上限。 */
const RESOLUTION_MAX_LENGTH = 1000;

/**
 * 裁定ゲート内の管理者メッセージの処理(M6)。
 * 提案理由受領ゲートと同様のガードを掛け、無条件キャプチャを防ぐ:
 * - 「キャンセル」等 → ゲート解除(resolution_requested_at をクリア)して案内
 * - タスク指示らしいメッセージ・疑問符で終わる質問・長さ上限超過 → 記録せず案内(ゲートは維持)
 * - それ以外 → 従来どおり裁定として記録+decision_rules へ還流
 */
async function handleAwaitingResolutionMessage(
  pool: pg.Pool,
  user: OpsUser,
  escalationId: string,
  text: string,
): Promise<ChatAppMessage> {
  const trimmed = text.trim();
  if (RESOLUTION_CANCEL_PATTERN.test(trimmed)) {
    await cancelResolutionRecording(pool, escalationId);
    return {
      text: '裁定の記録を中止しました。記録する場合は、エスカレーションカードの「裁定を記録」をもう一度押してください。',
    };
  }
  if (trimmed.length > RESOLUTION_MAX_LENGTH) {
    return {
      text: `裁定が長すぎるため記録しませんでした(${RESOLUTION_MAX_LENGTH}字以内)。裁定の記録待ちです。裁定を入力するか「キャンセル」と送ってください。`,
    };
  }
  // 疑問符で終わる質問、タスク指示に合致するメッセージは裁定として記録しない。
  // タスク指示判定は isTaskInstruction を再利用(ルールベース確定はプレフィックスのみ、
  // 曖昧なシグナルは flash-lite 分類)。担当者への言及を含む正当な裁定を締め出さないため、
  // ルールベースのシグナルだけでは弾かない
  if (/[??]\s*$/.test(trimmed) || (await isTaskInstruction(user, trimmed))) {
    return {
      text: '裁定の記録待ちです。裁定を入力するか「キャンセル」と送ってください。',
    };
  }
  return recordEscalationResolution(pool, user, escalationId, text);
}

/**
 * MESSAGE イベントのハンドラ。
 * 優先順(v0.9 §3 で改訂): 裁定の受領(管理者) → 提案理由の受領
 *        → 明示的なタスク指示(管理者・ルールベース確定シグナルのみ)
 *        → 進行中の朝夕対話・状況確認の継続 → 曖昧なタスク指示の分類(管理者)
 *        → 完了申告の検知 → 随時 QA
 * 「タスク:」等の明示的な指示は進行中対話より優先する(管理者が朝の問いかけに未返信でも
 * タスク起票できる — v0.8 §3.4 の既知の制約の解消)。曖昧な「指示らしさ」では従来どおり
 * 対話の継続を優先し、朝夕対話の途中のメッセージがタスク起票に横取りされないようにする。
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
      return handleAwaitingResolutionMessage(pool, user, awaitingEscalation.escalation_id, text);
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

  // 明示的なタスク指示(「タスク:」等のルールベース確定シグナル)は進行中対話より優先する
  // (v0.9 §3)。flash-lite 分類を要する曖昧なシグナルはここでは扱わず、後段の
  // isTaskInstruction 評価に委ねる(誤起票より対話保護を優先)
  if (user.role === 'admin' && detectTaskInstruction(text) === 'yes') {
    return handleTaskInstruction(pool, user, text);
  }

  // 進行中の朝夕対話・状況確認の継続を評価する(曖昧なタスク指示検知による横取り防止)
  const open = await findOpenDialogue(pool, user.user_id, jstDateString());
  if (open !== undefined) {
    if (open.dialogue_type === 'morning_checkin') {
      return continueMorningDialogue(pool, user, open, text);
    }
    if (open.dialogue_type === 'adhoc_checkin') {
      return continueAdhocCheckinDialogue(pool, user, open, text);
    }
    return continueEveningDialogue(pool, user, open, text);
  }

  // 管理者のタスク指示(M3)。ルールベース先行+曖昧な場合のみ flash-lite で分類
  if (await isTaskInstruction(user, text)) {
    return handleTaskInstruction(pool, user, text);
  }

  if (looksLikeCompletionReport(text)) {
    const message = await startEveningDialogue(pool, user, text);
    // 未完了タスクとの照合(確度が高い場合のみ完了確認カードを付与)
    await attachTaskDoneConfirmation(pool, user, text, message);
    return message;
  }

  return answerAdhocQuestion(pool, user, text);
}
