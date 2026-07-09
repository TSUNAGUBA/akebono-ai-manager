import {
  DAILY_REPORT_INSTRUCTION,
  DIALOGUE_SUMMARY_INSTRUCTION,
  embedTexts,
  generateContent,
  jstDateString,
  logger,
  query,
  reportConfirmCard,
  sendChatMessage,
  SYSTEM_PROMPT,
  toVectorLiteral,
} from '@ai-manager/shared';
import type pg from 'pg';
import { buildDialogueDigest, fallbackDailyReport, type DialogueDigestRow } from '../report-format.js';
import type { JobSummary } from './morning-checkin.js';

interface MemberRow {
  user_id: string;
  display_name: string;
  chat_space_id: string | null;
}

interface DialogueRow extends DialogueDigestRow {
  dialogue_id: string;
}

/**
 * 日報自動生成(M4)。
 * 冪等性・状態保護: UNIQUE(report_type, user_id, report_date)で UPSERT し、
 * 本人確認済み(confirmed_by_user = TRUE)の日報は内容も含めて一切更新しない。
 */
export async function runDailyReport(pool: pg.Pool): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  const today = jstDateString();

  const members = await query<MemberRow>(
    pool,
    `SELECT user_id, display_name, chat_space_id
     FROM ops.users WHERE active AND role = 'member'`,
  );

  for (const member of members.rows) {
    try {
      const dialogues = await query<DialogueRow>(
        pool,
        `SELECT dialogue_id, dialogue_type, created_at, turns, hypothesis, review
         FROM ops.dialogues
         WHERE user_id = $1
           AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
           AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
         ORDER BY created_at`,
        [member.user_id, today],
      );
      if (dialogues.rows.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const confirmed = await query<{ report_id: string }>(
        pool,
        `SELECT report_id FROM ops.reports
         WHERE report_type = 'daily' AND user_id = $1 AND report_date = $2 AND confirmed_by_user`,
        [member.user_id, today],
      );
      if (confirmed.rows.length > 0) {
        // 確認済みの日報は再生成しない(状態保護)
        summary.skipped += 1;
        continue;
      }

      const digest = buildDialogueDigest(dialogues.rows);
      let content: string;
      try {
        const result = await generateContent({
          tier: 'flash',
          system: `${SYSTEM_PROMPT}\n\n${DAILY_REPORT_INSTRUCTION}`,
          messages: [{ role: 'user', text: `メンバー: ${member.display_name}\n\n## 当日の対話ログ\n${digest}` }],
        });
        content = result.text;
      } catch (err) {
        logger.warn('日報の AI 生成に失敗したため自動整形版を使用します', {
          userId: member.user_id,
          error: String(err),
        });
        content = fallbackDailyReport(dialogues.rows);
      }

      const upserted = await query<{ report_id: string }>(
        pool,
        `INSERT INTO ops.reports (report_type, user_id, report_date, content, source_dialogue_ids)
         VALUES ('daily', $1, $2, $3, $4)
         ON CONFLICT (report_type, user_id, report_date)
           DO UPDATE SET content = EXCLUDED.content, source_dialogue_ids = EXCLUDED.source_dialogue_ids
           WHERE ops.reports.confirmed_by_user = FALSE
         RETURNING report_id`,
        [member.user_id, today, content, dialogues.rows.map((d) => d.dialogue_id)],
      );
      const reportId = upserted.rows[0]?.report_id;
      if (reportId === undefined) {
        // WHERE 句により確認済み日報は更新されない(直前チェックとの競合時)
        summary.skipped += 1;
        continue;
      }

      if (member.chat_space_id !== null) {
        await sendChatMessage(member.chat_space_id, {
          cardsV2: [reportConfirmCard(reportId, today, content)],
        });
      } else {
        logger.warn('DM スペース未登録のため日報カードを配信できませんでした', {
          userId: member.user_id,
        });
      }

      // 過去対話の要約ベクトル化(補助処理: 失敗しても日報フローは止めない)
      try {
        await embedDialogues(pool, member.user_id, dialogues.rows);
      } catch (err) {
        logger.error('対話ベクトル化に失敗しました(処理は継続)', err, { userId: member.user_id });
      }

      summary.sent += 1;
    } catch (err) {
      logger.error('日報生成に失敗しました(次のユーザーへ継続)', err, { userId: member.user_id });
      summary.failed += 1;
    }
  }
  return summary;
}

/** 当日対話を要約してベクトル化し、rag.dialogue_embeddings に保存する(要件 7.4)。 */
async function embedDialogues(pool: pg.Pool, userId: string, dialogues: DialogueRow[]): Promise<void> {
  for (const dialogue of dialogues) {
    const exists = await query(
      pool,
      'SELECT 1 FROM rag.dialogue_embeddings WHERE dialogue_id = $1',
      [dialogue.dialogue_id],
    );
    if (exists.rows.length > 0) continue;

    const digest = buildDialogueDigest([dialogue]);
    const summaryResult = await generateContent({
      tier: 'flash-lite',
      system: DIALOGUE_SUMMARY_INSTRUCTION,
      messages: [{ role: 'user', text: digest }],
      maxOutputTokens: 256,
    });
    const [embedding] = await embedTexts([summaryResult.text], 'RETRIEVAL_DOCUMENT');
    if (embedding === undefined) continue;
    await query(
      pool,
      `INSERT INTO rag.dialogue_embeddings (dialogue_id, user_id, summary_text, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (dialogue_id) DO NOTHING`,
      [dialogue.dialogue_id, userId, summaryResult.text, toVectorLiteral(embedding)],
    );
  }
}
