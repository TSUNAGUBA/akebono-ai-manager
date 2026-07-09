import {
  generateContent,
  jstDateString,
  jstDateStringDaysAgo,
  logger,
  query,
  sendChatMessage,
  SYSTEM_PROMPT,
  WEEKLY_SUMMARY_INSTRUCTION,
} from '@ai-manager/shared';
import type pg from 'pg';
import type { JobSummary } from './morning-checkin.js';

/**
 * 週次管理者サマリ(M4)。直近7日の横断状況を集計し、管理者へ DM 配信する。
 * 冪等性: UNIQUE(report_type, user_id, report_date)で UPSERT(確認フラグは日報専用のため考慮不要だが、
 * 再実行時は内容を最新データで更新する)。
 */
export async function runWeeklySummary(pool: pg.Pool): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  const today = jstDateString();
  const weekAgo = jstDateStringDaysAgo(6);

  // ── データ収集(6社横断の進捗、停滞点、エスカレーション候補)──
  const taskMoves = await query<{ project_name: string | null; status_to: string; cnt: string }>(
    pool,
    `SELECT p.name AS project_name, l.status_to, count(*) AS cnt
     FROM ops.task_status_log l
     JOIN ops.tasks t ON t.task_id = l.task_id
     LEFT JOIN ops.projects p ON p.project_id = t.project_id
     WHERE l.changed_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Tokyo')
     GROUP BY p.name, l.status_to
     ORDER BY p.name NULLS LAST`,
    [weekAgo],
  );

  const stuckTasks = await query<{ title: string; status: string; assignee: string | null; project_name: string | null; due_date: string | null }>(
    pool,
    `SELECT t.title, t.status, u.display_name AS assignee, p.name AS project_name, t.due_date::text AS due_date
     FROM ops.tasks t
     LEFT JOIN ops.users u ON u.user_id = t.assignee_id
     LEFT JOIN ops.projects p ON p.project_id = t.project_id
     WHERE t.status = 'blocked'
        OR (t.status NOT IN ('done', 'cancelled') AND t.due_date < $1::date)
     ORDER BY t.due_date NULLS LAST
     LIMIT 20`,
    [today],
  );

  const escalations = await query<{ reason: string; context: string; status: string; created_at: Date }>(
    pool,
    `SELECT reason, context, status, created_at
     FROM ops.escalations
     WHERE status = 'open'
        OR created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Tokyo')
     ORDER BY created_at DESC
     LIMIT 20`,
    [weekAgo],
  );

  const dialogueStats = await query<{ display_name: string; checkins: string; reviews: string; questions: string }>(
    pool,
    `SELECT u.display_name,
            count(*) FILTER (WHERE d.dialogue_type = 'morning_checkin' AND d.hypothesis IS NOT NULL) AS checkins,
            count(*) FILTER (WHERE d.review IS NOT NULL) AS reviews,
            count(*) FILTER (WHERE d.dialogue_type = 'adhoc_qa') AS questions
     FROM ops.users u
     LEFT JOIN ops.dialogues d
       ON d.user_id = u.user_id
      AND d.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Tokyo')
     WHERE u.active AND u.role = 'member'
     GROUP BY u.display_name`,
    [weekAgo],
  );

  const dataDigest = [
    `## 対象期間: ${weekAgo} 〜 ${today}`,
    '',
    '## タスク状態遷移(プロジェクト別)',
    ...taskMoves.rows.map((r) => `- ${r.project_name ?? '(未割当)'}: ${r.status_to} × ${r.cnt}`),
    '',
    '## 停滞・期限超過タスク',
    ...(stuckTasks.rows.length === 0
      ? ['- なし']
      : stuckTasks.rows.map(
          (r) =>
            `- [${r.project_name ?? '未割当'}] ${r.title}(${r.status} / 担当: ${r.assignee ?? '未定'} / 期限: ${r.due_date ?? 'なし'})`,
        )),
    '',
    '## エスカレーション',
    ...(escalations.rows.length === 0
      ? ['- なし']
      : escalations.rows.map((r) => `- [${r.status}] ${r.reason}: ${r.context.slice(0, 120)}`)),
    '',
    '## メンバーの対話状況(直近7日)',
    ...dialogueStats.rows.map(
      (r) => `- ${r.display_name}: 朝の問答 ${r.checkins} 回 / 振り返り ${r.reviews} 回 / 質問 ${r.questions} 回`,
    ),
  ].join('\n');

  let content: string;
  try {
    const result = await generateContent({
      tier: 'pro',
      system: `${SYSTEM_PROMPT}\n\n${WEEKLY_SUMMARY_INSTRUCTION}`,
      messages: [{ role: 'user', text: dataDigest }],
    });
    content = result.text;
  } catch (err) {
    logger.warn('週次サマリの AI 生成に失敗したため集計データをそのまま配信します', {
      error: String(err),
    });
    content = `# 週次サマリ(自動整形版)\n\n${dataDigest}`;
  }

  const admins = await query<{ user_id: string; chat_space_id: string | null }>(
    pool,
    `SELECT user_id, chat_space_id FROM ops.users WHERE active AND role = 'admin'`,
  );

  for (const admin of admins.rows) {
    try {
      await query(
        pool,
        `INSERT INTO ops.reports (report_type, user_id, report_date, content)
         VALUES ('weekly_admin', $1, $2, $3)
         ON CONFLICT (report_type, user_id, report_date)
           DO UPDATE SET content = EXCLUDED.content
           WHERE ops.reports.confirmed_by_user = FALSE`,
        [admin.user_id, today, content],
      );
      if (admin.chat_space_id !== null) {
        await sendChatMessage(admin.chat_space_id, { text: `📋 週次サマリ(${today})\n\n${content}` });
        summary.sent += 1;
      } else {
        logger.warn('管理者の DM スペース未登録のため週次サマリを配信できませんでした', {
          userId: admin.user_id,
        });
        summary.skipped += 1;
      }
    } catch (err) {
      logger.error('週次サマリ配信に失敗しました(次の管理者へ継続)', err, { userId: admin.user_id });
      summary.failed += 1;
    }
  }
  return summary;
}
