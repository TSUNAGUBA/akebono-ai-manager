import { createHash } from 'node:crypto';
import {
  embedTexts,
  FEEDBACK_CORRECTION_INSTRUCTION,
  FEEDBACK_TEXT_MAX_LENGTH,
  feedbackCorrectionFallback,
  generateContent,
  logger,
  query,
  sendChatMessage,
  SYSTEM_PROMPT,
  toVectorLiteral,
} from '@ai-manager/shared';
import type pg from 'pg';
import { invalidJobParams, requireParam, requireTextParam, verifyAdminOperator } from '../job-validation.js';
import type { JobSummary } from './morning-checkin.js';

/**
 * ジョブパラメータ(v0.12 §7)。3形態を受け付ける:
 * - 新規: { dialogueId, dialogueCreatedAt, feedback, operatorUserId }
 *   対話は dialogue_id と created_at の両方で特定する(ops.dialogues は
 *   created_at のレンジパーティション表で、複合 PK の片方だけでは行を特定できないため)
 * - 再送: { feedbackId, operatorUserId } — status='pending' の既存フィードバックの配信を再試行する
 * - 還流のみ再試行: { feedbackId, refluxOnly: 'true', operatorUserId } —
 *   status='delivered' かつ knowledge_reflected=false の還流を再試行する(DM は送らない。
 *   配信は成功したが還流だけ失敗したケースの回復経路)
 */
export interface DialogueFeedbackParams {
  dialogueId?: string;
  dialogueCreatedAt?: string;
  feedback?: string;
  operatorUserId?: string;
  feedbackId?: string;
  refluxOnly?: string;
}

/** 配信に必要なフィードバック文脈(新規 INSERT 直後・既存行ロードの各形態を同形に正規化)。 */
interface FeedbackContext {
  feedbackId: string;
  dialogueId: string;
  userId: string;
  feedback: string;
  knowledgeReflected: boolean;
  /** 元対話(質問と誤回答)の整形済みテキスト。取得不能時はその旨の定型文 */
  originalBlock: string;
}

/** ops.dialogue_feedback の既存行(再送・還流のみ再試行が参照する列)。 */
interface FeedbackRow {
  feedback_id: string;
  dialogue_id: string;
  dialogue_created_at: string | Date;
  user_id: string;
  feedback: string;
  status: string;
  knowledge_reflected: boolean;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 元対話の turns を還流チャンク・プロンプト供給向けのテキストへ整形する。 */
function formatDialogueTurns(turns: unknown): string {
  if (!Array.isArray(turns) || turns.length === 0) {
    return '(元対話のログを取得できませんでした)';
  }
  return turns
    .map((turn) => {
      const t = turn as { role?: unknown; content?: unknown };
      return `${t.role === 'ai' ? 'AI' : '本人'}: ${String(t.content ?? '')}`;
    })
    .join('\n');
}

/**
 * 対話フィードバック(v0.12 §7): AI の誤回答への管理者フィードバックを記録し、
 * ナレッジへ還流したうえで、本人へ謝罪+訂正メッセージを DM 送信する。
 *
 * SoT は ops.dialogue_feedback(status: pending=未送達・再送可能 / delivered=送達済み)。
 * rag.knowledge_chunks の doc_id='feedback/{id}' チャンクはその還流キャッシュ(原則6)。
 * 戻り値: 送達成功 sent=1 / 並行実行との競合 skipped=1 /
 * 送達失敗(pending のまま=再送可能) failed=1。
 */
export async function runDialogueFeedback(
  pool: pg.Pool,
  params: DialogueFeedbackParams = {},
): Promise<JobSummary> {
  if (params.refluxOnly !== undefined && params.refluxOnly !== 'true') {
    throw invalidJobParams(`refluxOnly は 'true' のみ指定できます`, { refluxOnly: params.refluxOnly });
  }
  if (params.refluxOnly === 'true') {
    return retryRefluxOnly(pool, params);
  }
  const context =
    params.feedbackId === undefined
      ? await registerFeedback(pool, params)
      : await loadPendingFeedback(pool, params);
  return deliverCorrection(pool, context);
}

/** 新規形態: 対話を特定して ops.dialogue_feedback へ INSERT する(SoT への書込が先 — 原則6)。 */
async function registerFeedback(
  pool: pg.Pool,
  params: DialogueFeedbackParams,
): Promise<FeedbackContext> {
  const dialogueId = requireParam(params.dialogueId, 'dialogueId');
  const dialogueCreatedAt = requireParam(params.dialogueCreatedAt, 'dialogueCreatedAt');
  const feedback = requireTextParam(params.feedback, 'feedback', FEEDBACK_TEXT_MAX_LENGTH);
  const operatorUserId = requireParam(params.operatorUserId, 'operatorUserId');
  if (Number.isNaN(Date.parse(dialogueCreatedAt))) {
    throw invalidJobParams('dialogueCreatedAt は ISO 形式の日時で指定してください', { dialogueCreatedAt });
  }
  await verifyAdminOperator(pool, operatorUserId);

  const dialogue = await query<{ user_id: string; turns: unknown }>(
    pool,
    `SELECT user_id, turns FROM ops.dialogues
     WHERE dialogue_id = $1 AND created_at = $2::timestamptz`,
    [dialogueId, dialogueCreatedAt],
  );
  const original = dialogue.rows[0];
  if (original === undefined) {
    throw invalidJobParams('指定の対話が見つかりません', { dialogueId, dialogueCreatedAt });
  }

  const inserted = await query<{ feedback_id: string }>(
    pool,
    `INSERT INTO ops.dialogue_feedback
       (dialogue_id, dialogue_created_at, user_id, feedback, created_by)
     VALUES ($1, $2::timestamptz, $3, $4, $5)
     RETURNING feedback_id`,
    [dialogueId, dialogueCreatedAt, original.user_id, feedback, operatorUserId],
  );
  const feedbackId = inserted.rows[0]?.feedback_id;
  if (feedbackId === undefined) {
    throw new Error('フィードバックの登録結果が空でした');
  }
  return {
    feedbackId,
    dialogueId,
    userId: original.user_id,
    feedback,
    knowledgeReflected: false,
    originalBlock: formatDialogueTurns(original.turns),
  };
}

/**
 * 既存フィードバック形態(再送・還流のみ再試行)の共通検証+ロード。
 * 操作者の admin 検証は新規形態と対称に必須(多層防御)。
 */
async function loadFeedbackRow(pool: pg.Pool, params: DialogueFeedbackParams): Promise<FeedbackRow> {
  const feedbackId = requireParam(params.feedbackId, 'feedbackId');
  // 既存行を使う形態のため新規登録のパラメータとは併用できない(取り違え防止)
  if (params.dialogueId !== undefined || params.dialogueCreatedAt !== undefined || params.feedback !== undefined) {
    throw invalidJobParams('feedbackId(再送・還流再試行)と新規登録のパラメータは同時に指定できません');
  }
  const operatorUserId = requireParam(params.operatorUserId, 'operatorUserId');
  await verifyAdminOperator(pool, operatorUserId);

  const result = await query<FeedbackRow>(
    pool,
    `SELECT feedback_id, dialogue_id, dialogue_created_at, user_id, feedback, status, knowledge_reflected
     FROM ops.dialogue_feedback WHERE feedback_id = $1`,
    [feedbackId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw invalidJobParams('指定のフィードバックが見つかりません', { feedbackId });
  }
  return row;
}

/** 既存行を配信文脈へ正規化する(元対話が取得できなくても止めない — 原則4)。 */
async function toFeedbackContext(pool: pg.Pool, row: FeedbackRow): Promise<FeedbackContext> {
  const dialogue = await query<{ turns: unknown }>(
    pool,
    `SELECT turns FROM ops.dialogues WHERE dialogue_id = $1 AND created_at = $2`,
    [row.dialogue_id, row.dialogue_created_at],
  );
  const turns = dialogue.rows[0]?.turns;
  if (turns === undefined) {
    logger.warn('フィードバック対象の元対話を取得できませんでした(フィードバック本文のみで処理を継続)', {
      feedbackId: row.feedback_id,
      dialogueId: row.dialogue_id,
    });
  }
  return {
    feedbackId: row.feedback_id,
    dialogueId: row.dialogue_id,
    userId: row.user_id,
    feedback: row.feedback,
    knowledgeReflected: row.knowledge_reflected,
    originalBlock: formatDialogueTurns(turns),
  };
}

/**
 * 再送形態: pending の既存フィードバックをロードする。
 * delivered は対象外(本人へ同じ訂正を二重配信しない — 原則2)。
 */
async function loadPendingFeedback(
  pool: pg.Pool,
  params: DialogueFeedbackParams,
): Promise<FeedbackContext> {
  const row = await loadFeedbackRow(pool, params);
  if (row.status !== 'pending') {
    throw invalidJobParams('配信済みのフィードバックは再送できません(二重配信の防止)', {
      feedbackId: row.feedback_id,
      status: row.status,
    });
  }
  return toFeedbackContext(pool, row);
}

/**
 * 還流のみ再試行(v0.12 §7): 配信は成功したが還流だけ失敗した
 * 「delivered かつ knowledge_reflected=false」の回復経路。DM は送らない。
 * pending は再送(通常形態)が還流も再試行するため対象外。
 * オペレーターが明示的に還流を求めている操作のため、失敗はジョブ失敗として送出する
 * (escalation-action の reflux と同じ設計 — 画面にエラー表示させる)。
 */
async function retryRefluxOnly(pool: pg.Pool, params: DialogueFeedbackParams): Promise<JobSummary> {
  const row = await loadFeedbackRow(pool, params);
  if (row.status !== 'delivered') {
    throw invalidJobParams('還流の再試行は配信済みのフィードバックのみ対象です(未配信は再送を使ってください)', {
      feedbackId: row.feedback_id,
      status: row.status,
    });
  }
  if (row.knowledge_reflected) {
    // 既に還流済みの再実行は no-op(冪等。embedding の再計算コストも避ける)
    logger.info('既にナレッジへ還流済みのためスキップします', { feedbackId: row.feedback_id });
    return { sent: 0, skipped: 1, failed: 0 };
  }
  const context = await toFeedbackContext(pool, row);
  await refluxFeedbackToKnowledge(pool, context);
  logger.info('フィードバックをナレッジへ再還流しました', { feedbackId: row.feedback_id });
  return { sent: 1, skipped: 0, failed: 0 };
}

/**
 * フィードバックをナレッジ(decision_rules)へ還流する。
 * SoT は ops.dialogue_feedback。rag 側は doc_id='feedback/{id}' の UPSERT(再実行しても壊れない)。
 * 成功後に knowledge_reflected を立てる(shared の refluxResolutionToKnowledge と同じ SQL パターン。
 * 対象テーブル・チャンク構成が異なるため dialogue_feedback 用にここで実装する)。
 */
async function refluxFeedbackToKnowledge(pool: pg.Pool, context: FeedbackContext): Promise<void> {
  const chunkText = [
    '## 対象の対話(誤りを含む回答)',
    context.originalBlock,
    '',
    '## 管理者フィードバック(正しい内容)',
    context.feedback,
  ].join('\n');

  const [embedding] = await embedTexts([chunkText], 'RETRIEVAL_DOCUMENT');
  if (embedding === undefined) {
    throw new Error('フィードバックチャンクの embedding 生成結果が空でした');
  }

  await query(
    pool,
    `INSERT INTO rag.knowledge_chunks
       (doc_id, doc_type, customer_id, title, chunk_index, chunk_text, embedding, content_hash, updated_at)
     VALUES ($1, 'decision_rules', NULL, $2, 0, $3, $4::vector, $5, now())
     ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
       title = EXCLUDED.title,
       chunk_text = EXCLUDED.chunk_text,
       embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash,
       updated_at = now()`,
    [
      `feedback/${context.feedbackId}`,
      `フィードバック訂正: 対話 #${context.dialogueId}`,
      chunkText,
      toVectorLiteral(embedding),
      hashText(chunkText),
    ],
  );
  await query(
    pool,
    'UPDATE ops.dialogue_feedback SET knowledge_reflected = TRUE WHERE feedback_id = $1',
    [context.feedbackId],
  );
}

/**
 * 配信フロー(新規・再送共通): 還流 → 謝罪+訂正メッセージ生成 → 対話レコード作成 →
 * 送達のクレーム → DM 送信。
 *
 * クレームファースト設計(並行実行の二重 DM 防止): DM 送信の前に
 * pending → delivered の条件付き UPDATE(RETURNING)でアトミックに送達をクレームする。
 * 並行する2つのリクエストのうちクレームに成功した一方だけが DM を送信でき、敗者は
 * 自分の対話レコードを片付けて skipped で終わる(送信後に記録する順序だと、両者が
 * 送信してから片方だけ記録される二重 DM が起きる)。送信失敗時は pending へ戻す補償で
 * 再送可能な状態に回復する。
 *
 * 既知の制約(残余ウィンドウ): クレーム後〜送信前にプロセスが落ちた場合、
 * 「delivered だが未送達」の状態が残る(補償が走れない数百ミリ秒の窓)。この場合
 * 再送は二重配信防止により拒否されるため、オペレーターは本人への送達状況を確認のうえ、
 * 必要なら新規フィードバックとして登録し直す。
 */
async function deliverCorrection(pool: pg.Pool, context: FeedbackContext): Promise<JobSummary> {
  // 1. ナレッジ還流(未還流の場合のみ)。失敗は非ブロッキング(原則4):
  //    knowledge_reflected=false のまま残り、再送時にここで再試行される(手動回復パス)
  if (!context.knowledgeReflected) {
    try {
      await refluxFeedbackToKnowledge(pool, context);
    } catch (err) {
      logger.warn('フィードバックのナレッジ還流に失敗しました(配信は継続。再送時に再試行されます)', {
        feedbackId: context.feedbackId,
        error: String(err),
      });
    }
  }

  // 2. 配信先の DM スペース。未登録は failed(フィードバックは pending のまま=登録後に再送できる)
  const member = await query<{ chat_space_id: string | null }>(
    pool,
    'SELECT chat_space_id FROM ops.users WHERE user_id = $1',
    [context.userId],
  );
  const chatSpaceId = member.rows[0]?.chat_space_id ?? null;
  if (chatSpaceId === null) {
    logger.warn('DM スペース未登録のため訂正メッセージを配信できません(本人が Chat アプリに一度話しかけると登録されます)', {
      feedbackId: context.feedbackId,
      userId: context.userId,
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  // 3. 謝罪+訂正メッセージの生成。LLM 失敗時は定型文フォールバック(原則4:
  //    文面生成の失敗で訂正の送達自体を止めない)
  let messageText: string;
  let modelUsed: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  try {
    const result = await generateContent({
      tier: 'pro',
      system: [
        SYSTEM_PROMPT,
        FEEDBACK_CORRECTION_INSTRUCTION,
        `## 元の対話\n${context.originalBlock}`,
        `## 管理者からのフィードバック\n${context.feedback}`,
      ].join('\n\n'),
      messages: [{ role: 'user', text: 'お詫びと訂正のメッセージを作成してください。' }],
    });
    messageText = result.text;
    modelUsed = result.model;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    costUsd = result.costUsd;
  } catch (err) {
    logger.warn('訂正メッセージの生成に失敗したため定型文を使用します', {
      feedbackId: context.feedbackId,
      error: String(err),
    });
    messageText = feedbackCorrectionFallback(context.feedback);
  }

  // 4. 対話レコードを先に作成(SoT)、その後 Chat へ配信(adhoc-checkin と同じ補償設計)
  const inserted = await query<{ dialogue_id: string }>(
    pool,
    `INSERT INTO ops.dialogues
       (user_id, dialogue_type, turns, model_used, input_tokens, output_tokens, cost_usd)
     VALUES ($1, 'feedback_correction', $2::jsonb, $3, $4, $5, $6)
     RETURNING dialogue_id`,
    [
      context.userId,
      JSON.stringify([{ role: 'ai', content: messageText, ts: new Date().toISOString() }]),
      modelUsed ?? null,
      inputTokens,
      outputTokens,
      costUsd,
    ],
  );
  const correctionDialogueId = inserted.rows[0]?.dialogue_id;

  /** 補償: 未送達に終わった自分の訂正対話レコードを片付ける(送達済みに見せない)。 */
  const deleteOwnDialogue = async (): Promise<void> => {
    if (correctionDialogueId === undefined) return;
    await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [correctionDialogueId]).catch(
      (cleanupErr: unknown) => {
        logger.error('未送達の訂正対話レコード削除に失敗しました', cleanupErr, {
          feedbackId: context.feedbackId,
          dialogueId: correctionDialogueId,
        });
      },
    );
  };

  // 5. 送達のクレーム(冒頭コメント参照)。pending → delivered の条件付き UPDATE が
  //    0行なら並行敗者: DM を送らず自分の対話レコードを片付けてスキップ(二重配信の防止 — 原則2)
  const claimed = await query<{ feedback_id: string }>(
    pool,
    `UPDATE ops.dialogue_feedback
     SET status = 'delivered', delivered_at = now(), correction_dialogue_id = $2
     WHERE feedback_id = $1 AND status = 'pending'
     RETURNING feedback_id`,
    [context.feedbackId, correctionDialogueId ?? null],
  );
  if (claimed.rows.length === 0) {
    await deleteOwnDialogue();
    logger.warn('フィードバックは並行する実行が配信済みのためスキップします(二重配信の防止)', {
      feedbackId: context.feedbackId,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }

  // 6. DM 送信。失敗時はクレームを pending へ戻す補償で再送可能な状態に回復する
  try {
    await sendChatMessage(chatSpaceId, { text: messageText });
  } catch (sendErr) {
    await query(
      pool,
      `UPDATE ops.dialogue_feedback
       SET status = 'pending', delivered_at = NULL, correction_dialogue_id = NULL
       WHERE feedback_id = $1 AND status = 'delivered'`,
      [context.feedbackId],
    ).catch((rollbackErr: unknown) => {
      logger.error('配信失敗後のフィードバック巻き戻しに失敗しました(delivered のまま未送達の可能性)', rollbackErr, {
        feedbackId: context.feedbackId,
      });
    });
    await deleteOwnDialogue();
    logger.error('訂正メッセージの DM 送信に失敗しました(pending へ戻したため再送できます)', sendErr, {
      feedbackId: context.feedbackId,
      userId: context.userId,
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  logger.info('謝罪+訂正メッセージを配信しました', {
    feedbackId: context.feedbackId,
    userId: context.userId,
    dialogueId: correctionDialogueId,
  });
  return { sent: 1, skipped: 0, failed: 0 };
}
