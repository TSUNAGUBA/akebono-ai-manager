import { jstDateString, query } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section, statCard, statGrid, statusBadge } from '../render/components.js';
import { html, type Raw } from '../render/html.js';

/** 概要: プロジェクト横断の進捗とチームの今日の状態(全員閲覧可)。 */
export async function renderOverview(pool: pg.Pool): Promise<Raw> {
  const today = jstDateString();

  const taskStats = await query<{
    in_progress: string;
    blocked: string;
    overdue: string;
    open_total: string;
  }>(
    pool,
    `SELECT
       count(*) FILTER (WHERE status = 'in_progress') AS in_progress,
       count(*) FILTER (WHERE status = 'blocked') AS blocked,
       count(*) FILTER (WHERE status NOT IN ('done','cancelled') AND due_date < $1::date) AS overdue,
       count(*) FILTER (WHERE status NOT IN ('done','cancelled')) AS open_total
     FROM ops.tasks`,
    [today],
  );
  const stats = taskStats.rows[0];

  const checkin = await query<{ members: string; answered: string }>(
    pool,
    `SELECT
       (SELECT count(*) FROM ops.users WHERE active AND role = 'member') AS members,
       count(DISTINCT d.user_id) AS answered
     FROM ops.dialogues d
     JOIN ops.users u ON u.user_id = d.user_id AND u.role = 'member'
     WHERE d.dialogue_type = 'morning_checkin'
       AND d.hypothesis IS NOT NULL
       AND d.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND d.created_at <  (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')`,
    [today],
  );
  const members = Number(checkin.rows[0]?.members ?? 0);
  const answered = Number(checkin.rows[0]?.answered ?? 0);

  const escalations = await query<{
    reason: string;
    context: string;
    status: string;
    created: string;
  }>(
    pool,
    `SELECT reason, context, status, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'MM/DD HH24:MI') AS created
     FROM ops.escalations
     WHERE status = 'open' OR created_at > now() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 8`,
  );

  const health = await query<{
    project_name: string;
    customer_name: string | null;
    tasks_completed: string;
    avg_lead_time_hours: string | null;
    blocked_rate: string | null;
  }>(
    pool,
    `SELECT project_name, customer_name, tasks_completed, avg_lead_time_hours, blocked_rate
     FROM dwh.v_project_health
     ORDER BY activities DESC
     LIMIT 8`,
  );

  const reasonLabels: Record<string, string> = {
    low_confidence: 'AIの確信不足',
    customer_impact: '顧客影響',
    member_anomaly: 'メンバー状況',
    priority_conflict: '優先順位の競合',
  };

  return html`
    ${statGrid([
      statCard({ label: '進行中タスク', value: stats?.in_progress ?? '0' }),
      statCard({
        label: 'ブロック中',
        value: stats?.blocked ?? '0',
        tone: Number(stats?.blocked ?? 0) > 0 ? 'danger' : undefined,
      }),
      statCard({
        label: '期限超過',
        value: stats?.overdue ?? '0',
        tone: Number(stats?.overdue ?? 0) > 0 ? 'warn' : undefined,
      }),
      statCard({
        label: '今日の朝の問答',
        value: `${answered} / ${members}`,
        sub: '仮説まで到達した人数',
        tone: members > 0 && answered === members ? 'ok' : undefined,
      }),
      statCard({
        label: '未対応エスカレーション',
        value: String(escalations.rows.filter((e) => e.status === 'open').length),
        tone: escalations.rows.some((e) => e.status === 'open') ? 'warn' : undefined,
      }),
    ])}
    ${section(
      'エスカレーション(直近7日+未対応)',
      responsiveTable(
        [
          { key: 'created', label: '日時' },
          { key: 'reason', label: '種別' },
          { key: 'context', label: '内容' },
          { key: 'status', label: '状態' },
        ],
        escalations.rows.map((e) => ({
          created: e.created,
          reason: reasonLabels[e.reason] ?? e.reason,
          context: e.context.length > 80 ? `${e.context.slice(0, 80)}…` : e.context,
          status: statusBadge(e.status),
        })),
        { emptyText: 'エスカレーションはありません' },
      ),
      '判断が必要な事項は Chat でも管理者に通知されています',
    )}
    ${section(
      'プロジェクトヘルス',
      responsiveTable(
        [
          { key: 'project', label: 'プロジェクト' },
          { key: 'customer', label: '顧客' },
          { key: 'completed', label: '完了タスク', numeric: true },
          { key: 'leadTime', label: '平均リードタイム(h)', numeric: true },
          { key: 'blockedRate', label: 'ブロック率', numeric: true },
        ],
        health.rows.map((p) => ({
          project: p.project_name,
          customer: p.customer_name ?? '—',
          completed: p.tasks_completed,
          leadTime: p.avg_lead_time_hours ?? '—',
          blockedRate: p.blocked_rate === null ? '—' : `${Math.round(Number(p.blocked_rate) * 100)}%`,
        })),
        { emptyText: '集計データがまだありません(夜間ETLの実行後に表示されます)' },
      ),
      '夜間ETL(dwh スキーマ)で集計した履歴ベースの指標',
    )}
  `;
}
