import type pg from 'pg';
import { query } from './db.js';
import { logger } from './logger.js';

/**
 * プロジェクト計画情報(内容・目的・マイルストーン)の AI 対話への文脈供給(要件 v0.10 §4)。
 *
 * SoT(ops.projects / ops.project_milestones)をプロンプト組み立て時に直接参照する
 * (ADR-13 と同じ判断: 同期パスを作らない)。計画情報はすべて任意項目のため、
 * 未入力の項目は出力から省略する(「未入力」の羅列でプロンプトを汚さない)。
 *
 * データ境界(v0.10 §5):
 * - マイルストーンはプロジェクトにのみ属する(タスクの下に混ぜない)
 * - 顧客はプロジェクトの属性(顧客名)としてのみ表示する。顧客間関係などの
 *   顧客マスタ情報は customer-context(v0.7)の別ブロックが担い、ここには含めない
 * - タスクの一覧はプロジェクト文脈には含めない(本人のタスク状況ブロックが担う)
 */

interface ProjectRow {
  project_id: string;
  name: string;
  customer_name: string | null;
  objective: string | null;
  description: string | null;
}

interface MilestoneRow {
  project_id: string;
  title: string;
  due_date: string | null;
  status: string;
}

/** 1プロジェクト分の整形。任意項目は存在するものだけを出力する。 */
function formatProject(project: ProjectRow, milestones: MilestoneRow[]): string {
  const lines = [
    `### プロジェクト: ${project.name}${project.customer_name === null ? '' : `(顧客: ${project.customer_name})`}`,
  ];
  if (project.objective !== null && project.objective !== '') {
    lines.push(`- 目的: ${project.objective}`);
  }
  if (project.description !== null && project.description !== '') {
    lines.push(`- 内容: ${project.description}`);
  }
  if (milestones.length > 0) {
    lines.push('- マイルストーン:');
    for (const m of milestones) {
      const mark = m.status === 'done' ? '済' : '予定';
      const due = m.due_date === null ? '' : `(期日: ${m.due_date})`;
      lines.push(`  - [${mark}] ${m.title}${due}`);
    }
  }
  return lines.join('\n');
}

/** プロジェクト ID 集合の計画情報を取得して整形する(内部共通)。 */
async function fetchProjects(pool: pg.Pool, projectIds: string[]): Promise<string | undefined> {
  if (projectIds.length === 0) return undefined;
  const projects = await query<ProjectRow>(
    pool,
    `SELECT p.project_id, p.name, c.name AS customer_name, p.objective, p.description
     FROM ops.projects p
     LEFT JOIN ops.customers c ON c.customer_id = p.customer_id
     WHERE p.project_id = ANY($1::text[])
     ORDER BY p.priority NULLS LAST, p.project_id`,
    [projectIds],
  );
  if (projects.rows.length === 0) return undefined;

  const milestones = await query<MilestoneRow>(
    pool,
    `SELECT project_id, title, due_date::text AS due_date, status
     FROM ops.project_milestones
     WHERE project_id = ANY($1::text[])
     ORDER BY due_date NULLS LAST, milestone_id`,
    [projectIds],
  );
  const byProject = new Map<string, MilestoneRow[]>();
  for (const m of milestones.rows) {
    const list = byProject.get(m.project_id) ?? [];
    list.push(m);
    byProject.set(m.project_id, list);
  }

  return projects.rows
    .map((p) => formatProject(p, byProject.get(p.project_id) ?? []))
    .join('\n\n');
}

/**
 * 対話文脈に供給するプロジェクト数の上限。
 * タスク文脈(memberTasksSummary の LIMIT 5 等)と同様、プロンプトの際限ない肥大を防ぐ。
 */
const USER_CONTEXT_PROJECT_LIMIT = 5;

/**
 * 本人の未完了タスクが属する進行中(status = 'active')プロジェクトの計画情報を
 * 整形して返す(朝の問いかけ・状況確認の文脈用)。該当がなければ undefined。
 * 終了(closed)したプロジェクトは供給しない(タスク指示の分解候補と同じ扱い。
 * 優先度順に最大 ${USER_CONTEXT_PROJECT_LIMIT} 件 — v0.10 §4.1)。
 * 補助文脈のため非ブロッキング(開発原則 4): 失敗時は undefined を返す。
 */
export async function fetchProjectContextForUser(
  pool: pg.Pool,
  userId: string,
): Promise<string | undefined> {
  try {
    const result = await query<{ project_id: string }>(
      pool,
      `SELECT p.project_id
       FROM ops.tasks t
       JOIN ops.projects p ON p.project_id = t.project_id
       WHERE t.assignee_id = $1
         AND t.status IN ('approved', 'in_progress', 'blocked')
         AND p.status = 'active'
       GROUP BY p.project_id, p.priority
       ORDER BY p.priority NULLS LAST, p.project_id
       LIMIT ${USER_CONTEXT_PROJECT_LIMIT}`,
      [userId],
    );
    return await fetchProjects(
      pool,
      result.rows.map((r) => r.project_id),
    );
  } catch (err) {
    logger.error('プロジェクト文脈の取得に失敗しました(文脈なしで継続)', err, { userId });
    return undefined;
  }
}

/**
 * 指定プロジェクトの計画情報を整形して返す(随時 QA の文脈用)。
 * 見つからなければ undefined。補助文脈のため非ブロッキング(開発原則 4)。
 */
export async function fetchProjectContextById(
  pool: pg.Pool,
  projectId: string,
): Promise<string | undefined> {
  try {
    return await fetchProjects(pool, [projectId]);
  } catch (err) {
    logger.error('プロジェクト文脈の取得に失敗しました(文脈なしで継続)', err, { projectId });
    return undefined;
  }
}
