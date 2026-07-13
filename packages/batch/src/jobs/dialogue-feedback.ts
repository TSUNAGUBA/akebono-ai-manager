import { createHash } from 'node:crypto';
import {
  embedTexts,
  FEEDBACK_CORRECTION_INSTRUCTION,
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
 * ジョブパラメータ(v0.12 §7)。2形態を受け付ける:
 * - 新規: { dialogueId, dialogueCreatedAt, feedback, operatorUserId }
 *   対話は dialogue_id と created_at の両方で特定する(ops.dialogues は
 *   created_at のレンジパーティション表で、複合 PK の片方だけでは行を特定できないため)
 * - 再送: { feedbackId } — status='pending' の既存フィードバックの配信を再試行する
 */
export interface DialogueFeedbackParams {
  dialogueId?: string;
  dialogueCreatedAt?: string;
  feedback?: string;
  operatorUserId?: string;
  feedbackId?: string;
}

/** フィードバック本文の上限(ダッシュボードのフォームと同じ制約をジョブ側でも検証)。 */
const FEEDBACK_MAX_LENGTH = 2000;

/** 配信に必要なフィードバック文脈(新規 INSERT 直後・再送ロードの両形態を同形に正規化)。 */
interface FeedbackContext {
  feedbackId: string;
  dialogueId: string;
  userId: string;
  feedback: string;
  knowledgeReflected: boolean;
  /** 元対話(質問と誤回答)の整形済みテキスト。取得不能時はその旨の定型文 */
  originalBlock: string;
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
 * 戻り値: 送達成功 sent=1 / 送達失敗(pending のまま=再送可能) failed=1。
 */
export async function runDialogueFeedback(
  pool: pg.Pool,
  params: DialogueFeedbackParams = {},
): Promise<JobSummary> {
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
  const feedback = requireTextParam(params.feedback, 'feedback', FEEDBACK_MAX_LENGTH);
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
 * 再送形態: pending の既存フィードバックをロードする。
 * delivered は対象外(本人へ同じ訂正を二重配信しない — 原則2)。
 */
async function loadPendingFeedback(
  pool: pg.Pool,
  params: DialogueFeedbackParams,
): Promise<FeedbackContext> {
  const feedbackId = requireParam(params.feedbackId, 'feedbackId');
  // 再送は SoT の既存行を使うため新規パラメータとは併用できない(取り違え防止)
  if (params.dialogueId !== undefined || params.dialogueCreatedAt !== undefined || params.feedback !== undefined) {
    throw invalidJobParams('feedbackId(再送)と新規登録のパラメータは同時に指定できません');
  }
  // 再送起動でも操作者が渡された場合は同様に検証する(多層防御)
  if (params.operatorUserId !== undefined) {
    await verifyAdminOperator(pool, params.operatorUserId);
  }

  const result = await query<{
    feedback_id: string;
    dialogue_id: string;
    dialogue_created_at: string | Date;
    user_id: string;
    feedback: string;
    status: string;
    knowledge_reflected: boolean;
  }>(
    pool,
    `SELECT feedback_id, dialogue_id, dialogue_created_at, user_id, feedback, status, knowledge_reflected
     FROM ops.dialogue_feedback WHERE feedback_id = $1`,
    [feedbackId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw invalidJobParams('指定のフィードバックが見つかりません', { feedbackId });
  }
  if (row.status !== 'pending') {
    throw invalidJobParams('配信済みのフィードバックは再送できません(二重配信の防止)', {
      feedbackId,
      status: row.status,
    });
  }

  // 元対話は文脈供給用のため、取得できなくても再送自体は止めない(訂正の送達を優先 — 原則4)
  const dialogue = await query<{ turns: unknown }>(
    pool,
    `SELECT turns FROM ops.dialogues WHERE dialogue_id = $1 AND created_at = $2`,
    [row.dialogue_id, row.dialogue_created_at],
  );
  const turns = dialogue.rows[0]?.turns;
  if (turns === undefined) {
    logger.warn('フィードバック対象の元対話を取得できませんでした(フィードバック本文のみで配信を継続)', {
      feedbackId,
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
 * 配信フロー(両形態共通): 還流 → 謝罪+訂正メッセージ生成 → 対話レコード作成 → DM 送信 →
 * 送達の記録。adhoc-checkin と同じ SoT ファースト+補償削除パターン。
 * 送信に失敗した場合、フィードバックは pending のまま残るため再送で回復できる。
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
  try {
    await sendChatMessage(chatSpaceId, { text: messageText });
  } catch (sendErr) {
    // 届いていない訂正の対話レコードが残ると送達済みに見えてしまうため補償削除する。
    // フィードバックは pending のまま(送達の記録前)なので再送で回復できる
    if (correctionDialogueId !== undefined) {
      await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [correctionDialogueId]).catch(
        (cleanupErr: unknown) => {
          logger.error('配信失敗後の訂正対話レコード削除に失敗しました', cleanupErr, {
            feedbackId: context.feedbackId,
            dialogueId: correctionDialogueId,
          });
        },
      );
    }
    logger.error('訂正メッセージの DM 送信に失敗しました(フィードバックは pending のまま=再送可能)', sendErr, {
      feedbackId: context.feedbackId,
      userId: context.userId,
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  // 5. 送達の記録。status='pending' 条件付き UPDATE で、並行実行と競合しても
  //    送達済みの記録(delivered_at・correction_dialogue_id)を上書きしない(原則2)
  await query(
    pool,
    `UPDATE ops.dialogue_feedback
     SET status = 'delivered', delivered_at = now(), correction_dialogue_id = $2
     WHERE feedback_id = $1 AND status = 'pending'`,
    [context.feedbackId, correctionDialogueId ?? null],
  );
  logger.info('謝罪+訂正メッセージを配信しました', {
    feedbackId: context.feedbackId,
    userId: context.userId,
    dialogueId: correctionDialogueId,
  });
  return { sent: 1, skipped: 0, failed: 0 };
}
