import {
  fetchProjectContextForUser,
  generateContent,
  isJstWeekday,
  jstDateString,
  logger,
  MORNING_CHECKIN_INSTRUCTION,
  MORNING_QUESTIONS,
  query,
  sendChatMessage,
  SYSTEM_PROMPT,
} from '@ai-manager/shared';
import type pg from 'pg';
import { fetchTodayEventsText } from '../calendar.js';

export interface JobSummary {
  sent: number;
  skipped: number;
  failed: number;
}

/** LLM 不調時のフォールバック文面(グレースフルデグラデーション)。 */
function staticMorningMessage(tasksSummary: string): string {
  return [
    'おはようございます。今日の着手前に、3つだけ教えてください。',
    '',
    `本日のタスク状況:\n${tasksSummary}`,
    '',
    `1. ${MORNING_QUESTIONS[0]}`,
    `2. ${MORNING_QUESTIONS[1]}`,
    `3. ${MORNING_QUESTIONS[2]}`,
    '',
    '答えに迷ったら、わかるところまでで大丈夫です。一緒に考えましょう。',
  ].join('\n');
}

interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  chat_space_id: string | null;
}

interface TaskRow {
  title: string;
  status: string;
  due_date: string | null;
  project_name: string | null;
}

/**
 * 本人の着手中タスク(approved / in_progress / blocked)を問いかけ文面向けの
 * 箇条書きテキストに整形する。朝の問いかけと状況確認(adhoc-checkin)で共用する。
 */
export async function memberTasksSummary(pool: pg.Pool, userId: string): Promise<string> {
  const tasks = await query<TaskRow>(
    pool,
    `SELECT t.title, t.status, t.due_date::text AS due_date, p.name AS project_name
     FROM ops.tasks t
     LEFT JOIN ops.projects p ON p.project_id = t.project_id
     WHERE t.assignee_id = $1 AND t.status IN ('approved', 'in_progress', 'blocked')
     ORDER BY t.due_date NULLS LAST, t.task_id
     LIMIT 5`,
    [userId],
  );
  if (tasks.rows.length === 0) return '(登録済みの着手中タスクはありません)';
  return tasks.rows
    .map((t) => {
      const project = t.project_name === null ? '' : `[${t.project_name}] `;
      const due = t.due_date === null ? '' : `(期限: ${t.due_date})`;
      return `- ${project}${t.title} ${due}`;
    })
    .join('\n');
}

/**
 * 朝の問いかけ配信(M2)。
 * 対象: 問いかけ可(checkin_enabled)の active なユーザー(v0.8 でロール固定から変更。
 * 可否はダッシュボードの /admin/users から管理者がユーザー単位で設定する)。
 * 冪等性: 当日分の morning_checkin 対話が既にあるユーザーはスキップする。
 * 非ブロッキング: 個別ユーザーの失敗は記録して次のユーザーへ進む。
 */
export async function runMorningCheckin(pool: pg.Pool): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  if (!isJstWeekday()) {
    logger.info('休日のため朝の問いかけをスキップします');
    return summary;
  }
  const today = jstDateString();

  const members = await query<MemberRow>(
    pool,
    `SELECT user_id, display_name, email, chat_space_id
     FROM ops.users WHERE active AND checkin_enabled`,
  );

  for (const member of members.rows) {
    try {
      if (member.chat_space_id === null) {
        logger.warn('DM スペース未登録のためスキップ(本人が Chat アプリに一度話しかけると登録されます)', {
          userId: member.user_id,
        });
        summary.skipped += 1;
        continue;
      }

      const existing = await query(
        pool,
        `SELECT 1 FROM ops.dialogues
         WHERE user_id = $1 AND dialogue_type = 'morning_checkin'
           AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
           AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
         LIMIT 1`,
        [member.user_id, today],
      );
      if (existing.rows.length > 0) {
        summary.skipped += 1;
        continue;
      }

      const tasksSummary = await memberTasksSummary(pool, member.user_id);

      // カレンダー(CALENDAR_ENABLED 時のみ。失敗時は undefined でタスクのみにフォールバック)
      const calendarText = await fetchTodayEventsText(member.email);
      const calendarBlock =
        calendarText === undefined ? '' : `\n本日の予定:\n${calendarText}`;
      // プロジェクトの計画情報(v0.10 §4.1。任意項目のため該当なしなら省略。内部で非ブロッキング)
      const projectContext = await fetchProjectContextForUser(pool, member.user_id);
      const projectBlock =
        projectContext === undefined ? '' : `\nプロジェクト文脈:\n${projectContext}`;

      let messageText: string;
      let modelUsed: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      try {
        const result = await generateContent({
          tier: 'flash-lite',
          system: `${SYSTEM_PROMPT}\n\n${MORNING_CHECKIN_INSTRUCTION}`,
          messages: [
            {
              role: 'user',
              text: `メンバー: ${member.display_name}\n本日のタスク状況:\n${tasksSummary}${calendarBlock}${projectBlock}`,
            },
          ],
        });
        messageText = result.text;
        modelUsed = result.model;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        costUsd = result.costUsd;
      } catch (err) {
        logger.warn('朝の問いかけ生成に失敗したため定型文を使用します', {
          userId: member.user_id,
          error: String(err),
        });
        messageText = staticMorningMessage(tasksSummary);
      }

      // 対話レコードを先に作成(SoT)、その後 Chat へ配信
      const inserted = await query<{ dialogue_id: string }>(
        pool,
        `INSERT INTO ops.dialogues
           (user_id, dialogue_type, turns, model_used, input_tokens, output_tokens, cost_usd)
         VALUES ($1, 'morning_checkin', $2::jsonb, $3, $4, $5, $6)
         RETURNING dialogue_id`,
        [
          member.user_id,
          JSON.stringify([{ role: 'ai', content: messageText, ts: new Date().toISOString() }]),
          modelUsed ?? null,
          inputTokens,
          outputTokens,
          costUsd,
        ],
      );
      const dialogueId = inserted.rows[0]?.dialogue_id;
      try {
        await sendChatMessage(member.chat_space_id, { text: messageText });
      } catch (sendErr) {
        // 配信に失敗したまま対話レコードが残ると、冪等チェックにより
        // 再実行してもそのユーザーへ二度と配信されないため、補償として削除する
        if (dialogueId !== undefined) {
          await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [dialogueId]).catch(
            (cleanupErr: unknown) => {
              logger.error('配信失敗後の対話レコード削除に失敗しました(再実行時に skipped になります)', cleanupErr, {
                userId: member.user_id,
                dialogueId,
              });
            },
          );
        }
        throw sendErr;
      }
      logger.info('朝の問いかけを配信しました', {
        userId: member.user_id,
        dialogueId,
      });
      summary.sent += 1;
    } catch (err) {
      logger.error('朝の問いかけ配信に失敗しました(次のユーザーへ継続)', err, {
        userId: member.user_id,
      });
      summary.failed += 1;
    }
  }
  return summary;
}
