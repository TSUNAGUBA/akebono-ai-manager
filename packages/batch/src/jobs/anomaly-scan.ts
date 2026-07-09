import { logger, optionalEnv, optionalIntEnv, query, sendChatMessage } from '@ai-manager/shared';
import type pg from 'pg';
import type { JobSummary } from './morning-checkin.js';

/**
 * M6: メンバーの異常シグナル検知(停滞・過負荷・回答の質の急落)。
 * 検知は決定的 SQL+閾値(環境変数)で行い、LLM は使わない(再現可能な監視)。
 * 起票(ops.escalations)が SoT。管理者通知は補助処理で、失敗しても起票は巻き戻さない。
 *
 * 閾値:
 *   ANOMALY_STALL_DAYS          停滞とみなす未更新日数(既定 3)
 *   ANOMALY_OVERLOAD_TASKS      過負荷とみなす保有タスク数(既定 7)
 *   ANOMALY_QUALITY_MIN_SAMPLES 質低下判定に必要な対話数/週(既定 3)
 *   ANOMALY_COOLDOWN_DAYS       同一シグナルの再起票抑止期間(既定 7)
 */
export async function runAnomalyScan(pool: pg.Pool): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  const stallDays = optionalIntEnv('ANOMALY_STALL_DAYS', 3);
  const overloadTasks = optionalIntEnv('ANOMALY_OVERLOAD_TASKS', 7);
  const minSamples = optionalIntEnv('ANOMALY_QUALITY_MIN_SAMPLES', 3);
  const cooldownDays = optionalIntEnv('ANOMALY_COOLDOWN_DAYS', 7);

  // ── 1) 停滞: in_progress のまま一定日数更新がないタスク ────────────────
  const stalled = await query<{
    task_id: string;
    title: string;
    assignee_id: string | null;
    display_name: string | null;
    days: string;
  }>(
    pool,
    `SELECT t.task_id, t.title, t.assignee_id, u.display_name,
            floor(extract(epoch FROM (now() - t.updated_at)) / 86400)::int AS days
       FROM ops.tasks t
       LEFT JOIN ops.users u ON u.user_id = t.assignee_id
      WHERE t.status = 'in_progress'
        AND t.updated_at < now() - make_interval(days => $1)
        AND NOT EXISTS (
          SELECT 1 FROM ops.task_status_log l
           WHERE l.task_id = t.task_id AND l.changed_at > now() - make_interval(days => $1))`,
    [stallDays],
  );
  for (const t of stalled.rows) {
    await raiseAnomaly(pool, summary, {
      context: `停滞: タスク「${t.title}」(担当: ${t.display_name ?? '未割当'})が ${t.days} 日間更新されていません`,
      relatedUserId: t.assignee_id,
      relatedTaskId: t.task_id,
      dedupeKey: '停滞: タスク',
      cooldownDays,
    });
  }

  // ── 2) 過負荷: 保有タスク数(approved + in_progress)が閾値以上 ─────────
  const overloaded = await query<{ user_id: string; display_name: string; cnt: string }>(
    pool,
    `SELECT u.user_id, u.display_name, count(*) AS cnt
       FROM ops.tasks t
       JOIN ops.users u ON u.user_id = t.assignee_id
      WHERE t.status IN ('approved', 'in_progress') AND u.active
      GROUP BY u.user_id, u.display_name
     HAVING count(*) >= $1`,
    [overloadTasks],
  );
  for (const u of overloaded.rows) {
    await raiseAnomaly(pool, summary, {
      context: `過負荷: ${u.display_name} さんの保有タスクが ${u.cnt} 件(閾値 ${overloadTasks} 件)に達しています`,
      relatedUserId: u.user_id,
      relatedTaskId: null,
      dedupeKey: '過負荷:',
      cooldownDays,
    });
  }

  // ── 3) 回答の質の急落: 朝の対話の仮説表明率が直近 7 日で半分未満に低下 ────
  const qualityDrop = await query<{
    user_id: string;
    display_name: string;
    recent_rate: string;
    prior_rate: string;
  }>(
    pool,
    `WITH weekly AS (
       SELECT d.user_id,
              (d.created_at >= now() - interval '7 days') AS recent,
              count(*) AS dialogues,
              count(*) FILTER (WHERE d.hypothesis IS NOT NULL) AS with_hypothesis
         FROM ops.dialogues d
        WHERE d.dialogue_type = 'morning_checkin'
          AND d.created_at >= now() - interval '14 days'
        GROUP BY d.user_id, (d.created_at >= now() - interval '7 days')
     )
     SELECT u.user_id, u.display_name,
            round(r.with_hypothesis::numeric / r.dialogues, 2) AS recent_rate,
            round(p.with_hypothesis::numeric / p.dialogues, 2) AS prior_rate
       FROM weekly r
       JOIN weekly p ON p.user_id = r.user_id AND p.recent = false
       JOIN ops.users u ON u.user_id = r.user_id
      WHERE r.recent = true
        AND r.dialogues >= $1 AND p.dialogues >= $1
        AND p.with_hypothesis > 0
        AND r.with_hypothesis::numeric / r.dialogues < 0.5 * (p.with_hypothesis::numeric / p.dialogues)`,
    [minSamples],
  );
  for (const u of qualityDrop.rows) {
    await raiseAnomaly(pool, summary, {
      context: `回答の質の低下: ${u.display_name} さんの朝の対話の仮説表明率が ${u.prior_rate} → ${u.recent_rate} に低下しています`,
      relatedUserId: u.user_id,
      relatedTaskId: null,
      dedupeKey: '回答の質の低下:',
      cooldownDays,
    });
  }

  return summary;
}

/** 起票+管理者通知。クールダウン内の同種シグナルは再起票しない(冪等性)。 */
async function raiseAnomaly(
  pool: pg.Pool,
  summary: JobSummary,
  input: {
    context: string;
    relatedUserId: string | null;
    relatedTaskId: string | null;
    /** context の先頭一致でシグナル種別を同定する(停滞はタスク単位、他はユーザー単位) */
    dedupeKey: string;
    cooldownDays: number;
  },
): Promise<void> {
  try {
    const existing = await query(
      pool,
      `SELECT 1 FROM ops.escalations
        WHERE reason = 'member_anomaly'
          AND related_user_id IS NOT DISTINCT FROM $1
          AND related_task_id IS NOT DISTINCT FROM $2
          AND context LIKE $3 || '%'
          AND created_at > now() - make_interval(days => $4)`,
      [input.relatedUserId, input.relatedTaskId, input.dedupeKey, input.cooldownDays],
    );
    if (existing.rows.length > 0) {
      summary.skipped += 1;
      return;
    }

    await query(
      pool,
      `INSERT INTO ops.escalations (reason, context, related_task_id, related_user_id)
       VALUES ('member_anomaly', $1, $2, $3)`,
      [input.context, input.relatedTaskId, input.relatedUserId],
    );
    summary.sent += 1;
    logger.info('異常シグナルを起票しました', { context: input.context });

    const adminSpace = optionalEnv('ADMIN_SPACE_ID', '');
    if (adminSpace !== '') {
      await sendChatMessage(adminSpace, { text: `⚠️ 異常シグナル検知\n${input.context}` });
    }
  } catch (err) {
    // 1 件の失敗で走査全体を止めない(非ブロッキング)
    summary.failed += 1;
    logger.error('異常シグナルの起票に失敗しました(次のシグナルへ継続)', err, {
      context: input.context,
    });
  }
}
