import { jstDateString, query } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section, statusBadge } from '../render/components.js';
import { html, type Raw } from '../render/html.js';

/** プロジェクト横断の進捗(全員閲覧可)。運用中データ(ops)+ 履歴指標(dwh)。 */
export async function renderProjects(pool: pg.Pool): Promise<Raw> {
  const today = jstDateString();

  const projects = await query<{
    project_id: string;
    name: string;
    customer_name: string | null;
    status: string;
    open_cnt: string;
    in_progress_cnt: string;
    blocked_cnt: string;
    overdue_cnt: string;
  }>(
    pool,
    `SELECT
       p.project_id,
       p.name,
       c.name AS customer_name,
       p.status,
       count(t.task_id) FILTER (WHERE t.status IN ('proposed','approved')) AS open_cnt,
       count(t.task_id) FILTER (WHERE t.status = 'in_progress') AS in_progress_cnt,
       count(t.task_id) FILTER (WHERE t.status = 'blocked') AS blocked_cnt,
       count(t.task_id) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_date < $1::date) AS overdue_cnt
     FROM ops.projects p
     LEFT JOIN ops.customers c ON c.customer_id = p.customer_id
     LEFT JOIN ops.tasks t ON t.project_id = p.project_id
     GROUP BY p.project_id, p.name, c.name, p.status, p.priority
     ORDER BY p.priority NULLS LAST, p.name`,
    [today],
  );

  const health = await query<{
    project_id: string;
    avg_lead_time_hours: string | null;
    blocked_rate: string | null;
  }>(pool, `SELECT project_id, avg_lead_time_hours, blocked_rate FROM dwh.v_project_health`);
  const healthByProject = new Map(health.rows.map((r) => [r.project_id, r]));

  return html`${section(
    'プロジェクト一覧',
    responsiveTable(
      [
        { key: 'name', label: 'プロジェクト' },
        { key: 'customer', label: '顧客' },
        { key: 'status', label: '状態' },
        { key: 'open', label: '未着手', numeric: true },
        { key: 'inProgress', label: '進行中', numeric: true },
        { key: 'blocked', label: 'ブロック', numeric: true },
        { key: 'overdue', label: '期限超過', numeric: true },
        { key: 'leadTime', label: '平均LT(h)', numeric: true },
      ],
      projects.rows.map((p) => {
        const h = healthByProject.get(p.project_id);
        return {
          name: p.name,
          customer: p.customer_name ?? '—',
          status: statusBadge(p.status),
          open: p.open_cnt,
          inProgress: p.in_progress_cnt,
          blocked: p.blocked_cnt,
          overdue: p.overdue_cnt,
          leadTime: h?.avg_lead_time_hours ?? '—',
        };
      }),
      { emptyText: 'プロジェクトが登録されていません' },
    ),
    'タスク数は現在の状態(ops)、平均リードタイムは夜間ETLの集計(dwh)',
  )}`;
}
