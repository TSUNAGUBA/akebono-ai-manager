import { jstDateKey, jstDateString, query } from '@ai-manager/shared';
import type pg from 'pg';
import { checkinDots, responsiveTable, section } from '../render/components.js';
import { html, type Raw } from '../render/html.js';

/** タスク負荷マップ(全員閲覧可)。現在の負荷+直近14日の朝夕問答の実施状況。 */
export async function renderWorkload(pool: pg.Pool): Promise<Raw> {
  const today = jstDateString();
  const fromKey = jstDateKey(new Date(Date.now() - 13 * 24 * 60 * 60 * 1000));

  const users = await query<{
    user_id: string;
    display_name: string;
    role: string;
    open_cnt: string;
    in_progress_cnt: string;
    blocked_cnt: string;
    overdue_cnt: string;
  }>(
    pool,
    `SELECT
       u.user_id,
       u.display_name,
       u.role,
       count(t.task_id) FILTER (WHERE t.status IN ('proposed','approved')) AS open_cnt,
       count(t.task_id) FILTER (WHERE t.status = 'in_progress') AS in_progress_cnt,
       count(t.task_id) FILTER (WHERE t.status = 'blocked') AS blocked_cnt,
       count(t.task_id) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_date < $1::date) AS overdue_cnt
     FROM ops.users u
     LEFT JOIN ops.tasks t ON t.assignee_id = u.user_id
     WHERE u.active
     GROUP BY u.user_id, u.display_name, u.role
     ORDER BY u.role, u.display_name`,
    [today],
  );

  const history = await query<{
    user_id: string;
    date_key: number;
    checkin_completed: boolean;
    review_completed: boolean;
  }>(
    pool,
    `SELECT du.user_id, fw.date_key, fw.checkin_completed, fw.review_completed
     FROM dwh.fact_workload fw
     JOIN dwh.dim_user du ON du.user_key = fw.user_key
     WHERE fw.date_key >= $1
     ORDER BY fw.date_key`,
    [fromKey],
  );
  const historyByUser = new Map<string, Array<{ checkin: boolean; review: boolean }>>();
  for (const row of history.rows) {
    const list = historyByUser.get(row.user_id) ?? [];
    list.push({ checkin: row.checkin_completed, review: row.review_completed });
    historyByUser.set(row.user_id, list);
  }

  return html`${section(
    'メンバー別タスク負荷',
    responsiveTable(
      [
        { key: 'name', label: '名前' },
        { key: 'open', label: '未着手', numeric: true },
        { key: 'inProgress', label: '進行中', numeric: true },
        { key: 'blocked', label: 'ブロック', numeric: true },
        { key: 'overdue', label: '期限超過', numeric: true },
        { key: 'dots', label: '朝夕の問答(直近14日)' },
      ],
      users.rows.map((u) => ({
        name: u.role === 'admin' ? `${u.display_name}(管理者)` : u.display_name,
        open: u.open_cnt,
        inProgress: u.in_progress_cnt,
        blocked: u.blocked_cnt,
        overdue: u.overdue_cnt,
        dots: checkinDots(historyByUser.get(u.user_id) ?? []),
      })),
      { emptyText: 'ユーザーが登録されていません' },
    ),
    '緑 = 朝夕とも実施 / 黄 = どちらか一方 / 灰 = 未実施(夜間ETLの集計)',
  )}`;
}
