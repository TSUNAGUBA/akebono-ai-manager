import { query, withTransaction } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section, statusBadge } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import {
  auditLog,
  hasPgCode,
  invalidInput,
  optionalInt,
  optionalText,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  requireId,
  requireRef,
  requireText,
  writeConflict,
} from '../../admin/form.js';
import { adminTabs, csrfField, flashMessages, type AdminPageContext } from './common.js';

interface ProjectRow {
  project_id: string;
  name: string;
  customer_id: string | null;
  customer_name: string | null;
  project_type: string;
  status: string;
  priority: number | null;
  admin_owner_id: string | null;
  owner_name: string | null;
  description: string | null;
  objective: string | null;
  updated: string;
}

interface MilestoneRow {
  milestone_id: string;
  title: string;
  due_date: string | null;
  status: string;
}

interface TaskRow {
  task_id: string;
  title: string;
  status: string;
  due_date: string | null;
  assignee_name: string | null;
}

interface CustomerOption {
  customer_id: string;
  name: string;
}

interface AdminOption {
  user_id: string;
  display_name: string;
}

const PATH = '/admin/projects';

/** プロジェクト種別(0001 の CHECK 制約と同じ値集合。変更時は DDL と同時に更新する)。 */
const PROJECT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'si', label: 'SI' },
  { value: 'saas', label: 'SaaS' },
  { value: 'media', label: 'メディア' },
  { value: 'utsuwa', label: 'うつわ' },
  { value: 'internal', label: '社内' },
];

/**
 * プロジェクト状態。'active' のみがタスク指示(M3)の分解候補・稼働中の扱いになる
 * (chat-gateway の listActiveProjects が status = 'active' で絞る)。
 */
/** タスク状態(ops.tasks の CHECK 制約と同じ値集合。ラベルは statusBadge と揃える)。 */
const TASK_STATUSES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'proposed', label: '提案中' },
  { value: 'approved', label: '承認済み' },
  { value: 'in_progress', label: '進行中' },
  { value: 'blocked', label: 'ブロック' },
  { value: 'done', label: '完了' },
  { value: 'cancelled', label: '中止' },
];

const PROJECT_STATUSES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'active', label: '進行中' },
  { value: 'closed', label: '終了' },
];

function isValidChoice(list: ReadonlyArray<{ value: string }>, value: string): boolean {
  return list.some((item) => item.value === value);
}

/**
 * プロジェクトの一覧・追加・編集(要件 v0.9 §2)。
 * タスク(ops.tasks)が参照するため物理削除はせず、状態(終了)で運用する。
 * 顧客・担当管理者はマスタから選択(任意)。参照列は admin_rw の GRANT 範囲
 * (ops.projects / ops.customers / ops.users の列単位 SELECT)に収める。
 */
export async function renderAdminProjects(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const projects = await query<ProjectRow>(
    pool,
    `SELECT p.project_id, p.name, p.customer_id, c.name AS customer_name,
            p.project_type, p.status, p.priority, p.admin_owner_id,
            u.display_name AS owner_name, p.description, p.objective,
            to_char(p.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS updated
     FROM ops.projects p
     LEFT JOIN ops.customers c ON c.customer_id = p.customer_id
     LEFT JOIN ops.users u ON u.user_id = p.admin_owner_id
     ORDER BY p.status, p.priority NULLS LAST, p.project_id`,
  );
  const customers = await query<CustomerOption>(
    pool,
    `SELECT customer_id, name FROM ops.customers ORDER BY customer_id`,
  );
  const admins = await query<AdminOption>(
    pool,
    `SELECT user_id, display_name FROM ops.users
     WHERE active AND role = 'admin' ORDER BY display_name`,
  );

  const typeLabel = new Map(PROJECT_TYPES.map((t) => [t.value, t.label]));

  const editId = ctx.url.searchParams.get('edit');
  const editing = projects.rows.find((r) => r.project_id === editId);

  const table = responsiveTable(
    [
      { key: 'id', label: 'プロジェクトID' },
      { key: 'name', label: '名称' },
      { key: 'customer', label: '顧客' },
      { key: 'type', label: '種別' },
      { key: 'state', label: '状態' },
      { key: 'priority', label: '優先度', numeric: true },
      { key: 'owner', label: '担当管理者' },
      { key: 'updated', label: '更新日時' },
      { key: 'ops', label: '操作' },
    ],
    projects.rows.map((r) => ({
      id: r.project_id,
      name: r.name,
      customer: r.customer_name ?? '—',
      type: typeLabel.get(r.project_type) ?? r.project_type,
      state: statusBadge(r.status),
      priority: r.priority ?? '—',
      owner: r.owner_name ?? '—',
      updated: r.updated,
      ops: raw(`<a href="${h(`${PATH}?edit=${encodeURIComponent(r.project_id)}`)}">編集</a>`),
    })),
    { emptyText: 'プロジェクトが登録されていません' },
  );

  const selectField = (
    name: string,
    label: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    selected: string | null,
    emptyLabel?: string,
  ): Raw => {
    const empty =
      emptyLabel === undefined
        ? ''
        : `<option value=""${selected === null || selected === '' ? ' selected' : ''}>${h(emptyLabel)}</option>`;
    const items = options
      .map(
        (o) =>
          `<option value="${h(o.value)}"${o.value === selected ? ' selected' : ''}>${h(o.label)}</option>`,
      )
      .join('');
    return raw(`<label class="field">${h(label)}
      <select name="${h(name)}">${empty}${items}</select>
    </label>`);
  };

  const customerOptions = customers.rows.map((c) => ({ value: c.customer_id, label: c.name }));

  // 現在値がリスト外(SQL 直登録の status、無効化・降格された担当者)の場合は選択肢へ
  // 「(現在値)」として残し、無関係な編集での黙った書き換え(status→active への巻き戻り・
  // 担当者の NULL 化)を防ぐ(原則7。customers.ts の無効業界の扱いと同旨)
  const statusOptions = (r: ProjectRow | undefined): ReadonlyArray<{ value: string; label: string }> =>
    r !== undefined && !isValidChoice(PROJECT_STATUSES, r.status)
      ? [{ value: r.status, label: `${r.status}(現在値)` }, ...PROJECT_STATUSES]
      : PROJECT_STATUSES;
  const ownerOptions = (r: ProjectRow | undefined): ReadonlyArray<{ value: string; label: string }> => {
    const base = admins.rows.map((a) => ({ value: a.user_id, label: a.display_name }));
    if (
      r?.admin_owner_id != null &&
      !base.some((option) => option.value === r.admin_owner_id)
    ) {
      return [
        { value: r.admin_owner_id, label: `${r.owner_name ?? r.admin_owner_id}(現担当)` },
        ...base,
      ];
    }
    return base;
  };

  const projectFields = (r: ProjectRow | undefined): Raw => html`
    <label class="field">名称
      <input type="text" name="name" value="${r?.name ?? ''}" required maxlength="500" placeholder="例: A社SI">
    </label>
    ${selectField('customer_id', '顧客', customerOptions, r?.customer_id ?? null, '(なし)')}
    ${selectField('project_type', '種別', PROJECT_TYPES, r?.project_type ?? 'si')}
    ${selectField('status', '状態', statusOptions(r), r?.status ?? 'active')}
    <label class="field">優先度
      <input type="number" name="priority" value="${r?.priority ?? ''}" placeholder="例: 10(小さいほど優先)">
    </label>
    ${selectField('admin_owner_id', '担当管理者', ownerOptions(r), r?.admin_owner_id ?? null, '(未設定)')}
    <label class="field field-full">目的(任意)
      <textarea name="objective" rows="5" maxlength="2000" placeholder="このプロジェクトで何を達成するか">${r?.objective ?? ''}</textarea>
    </label>
    <label class="field field-full">内容(任意)
      <textarea name="description" rows="5" maxlength="2000" placeholder="プロジェクトの概要・スコープ">${r?.description ?? ''}</textarea>
    </label>
  `;

  const editForm =
    editing === undefined
      ? html``
      : html`<form method="post" action="${PATH}" class="card form">
          ${csrfField(ctx)}
          <input type="hidden" name="action" value="update">
          <input type="hidden" name="project_id" value="${editing.project_id}">
          <div class="form-grid">
            <label class="field">プロジェクトID
              <div class="readonly-id">${editing.project_id}</div>
            </label>
            ${projectFields(editing)}
          </div>
          <div class="btn-row">
            <button class="btn" type="submit">更新する</button>
            <a class="btn secondary" href="${PATH}">キャンセル</a>
          </div>
        </form>`;

  const createForm = html`<form method="post" action="${PATH}" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="create">
    <div class="form-grid">
      <label class="field">プロジェクトID
        <input type="text" name="project_id" required maxlength="64" pattern="[a-z0-9_\\-]+"
               placeholder="例: a-sha-si" title="半角の小文字英数字・ハイフン・アンダースコア">
      </label>
      ${projectFields(undefined)}
    </div>
    <p class="form-help">
      プロジェクトID はタスク・対話ログ・分析(dwh)から参照されるため、後から変更できません。
    </p>
    <button class="btn" type="submit">追加する</button>
  </form>`;

  // 編集中のみ、計画情報(マイルストーン)と所属タスクの管理セクションを表示する(v0.10)。
  // マイルストーンはプロジェクトにのみ属し、タスクは既存の ops.tasks.project_id で紐づく
  // (相互に混ぜない — v0.10 §5)
  let milestonesSection = html``;
  let tasksSection = html``;
  if (editing !== undefined) {
    const milestones = await query<MilestoneRow>(
      pool,
      `SELECT milestone_id, title, due_date::text AS due_date, status
       FROM ops.project_milestones
       WHERE project_id = $1
       ORDER BY due_date NULLS LAST, milestone_id`,
      [editing.project_id],
    );
    const tasks = await query<TaskRow>(
      pool,
      `SELECT t.task_id, t.title, t.status, t.due_date::text AS due_date,
              u.display_name AS assignee_name
       FROM ops.tasks t
       LEFT JOIN ops.users u ON u.user_id = t.assignee_id
       WHERE t.project_id = $1
       ORDER BY t.status, t.due_date NULLS LAST, t.task_id`,
      [editing.project_id],
    );

    const milestoneOps = (m: MilestoneRow): Raw =>
      raw(`<div class="btn-row">
        <form method="post" action="${PATH}" class="inline-form">
          ${csrfField(ctx).html}
          <input type="hidden" name="action" value="toggle_milestone">
          <input type="hidden" name="project_id" value="${h(editing.project_id)}">
          <input type="hidden" name="milestone_id" value="${h(m.milestone_id)}">
          <input type="hidden" name="status" value="${m.status === 'done' ? 'planned' : 'done'}">
          <button class="btn" type="submit">${m.status === 'done' ? '未完了に戻す' : '完了にする'}</button>
        </form>
        <form method="post" action="${PATH}" class="inline-form"
              onsubmit="return confirm('このマイルストーンを削除しますか?')">
          ${csrfField(ctx).html}
          <input type="hidden" name="action" value="delete_milestone">
          <input type="hidden" name="project_id" value="${h(editing.project_id)}">
          <input type="hidden" name="milestone_id" value="${h(m.milestone_id)}">
          <button class="btn secondary" type="submit">削除</button>
        </form>
      </div>`);

    const milestoneTable = responsiveTable(
      [
        { key: 'title', label: 'マイルストーン' },
        { key: 'due', label: '期日' },
        { key: 'state', label: '状態' },
        { key: 'ops', label: '操作' },
      ],
      milestones.rows.map((m) => ({
        title: m.title,
        due: m.due_date ?? '—',
        state: statusBadge(m.status),
        ops: milestoneOps(m),
      })),
      { emptyText: 'マイルストーンは登録されていません(任意項目です)' },
    );

    const milestoneAddForm = html`<form method="post" action="${PATH}" class="card form">
      ${csrfField(ctx)}
      <input type="hidden" name="action" value="add_milestone">
      <input type="hidden" name="project_id" value="${editing.project_id}">
      <div class="form-grid">
        <label class="field">マイルストーン名
          <input type="text" name="title" required maxlength="500" placeholder="例: 要件確定">
        </label>
        <label class="field">期日(任意)
          <input type="date" name="due_date">
        </label>
      </div>
      <button class="btn" type="submit">マイルストーンを追加</button>
    </form>`;

    milestonesSection = section(
      `マイルストーン: ${editing.name}`,
      html`${milestoneTable}${milestoneAddForm}`,
      'マイルストーンはこのプロジェクトにのみ属します(タスク・顧客とは独立)。登録すると AI の対話文脈に供給されます',
      'milestones',
    );

    const taskStatusForm = (t: TaskRow): Raw => {
      const options = TASK_STATUSES.map(
        (s) =>
          `<option value="${h(s.value)}"${s.value === t.status ? ' selected' : ''}>${h(s.label)}</option>`,
      ).join('');
      return raw(`<form method="post" action="${PATH}" class="inline-form">
        ${csrfField(ctx).html}
        <input type="hidden" name="action" value="update_task_status">
        <input type="hidden" name="project_id" value="${h(editing.project_id)}">
        <input type="hidden" name="task_id" value="${h(t.task_id)}">
        <select name="status">${options}</select>
        <button class="btn" type="submit">更新</button>
      </form>`);
    };

    const taskTable = responsiveTable(
      [
        { key: 'id', label: 'ID' },
        { key: 'title', label: 'タスク' },
        { key: 'assignee', label: '担当' },
        { key: 'due', label: '期限' },
        { key: 'state', label: '状態' },
        { key: 'ops', label: '進捗の更新' },
      ],
      tasks.rows.map((t) => ({
        id: t.task_id,
        title: t.title,
        assignee: t.assignee_name ?? '—',
        due: t.due_date ?? '—',
        state: statusBadge(t.status),
        ops: taskStatusForm(t),
      })),
      { emptyText: 'このプロジェクトのタスクはまだありません' },
    );

    tasksSection = section(
      `タスクと進捗: ${editing.name}`,
      taskTable,
      'ここでは状態の更新のみ行えます(遷移は履歴に記録されます)。タスクの起票・題名・担当・期限の変更は Chat のタスク指示(M3 の承認フロー)から行ってください',
      'tasks',
    );
  }

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${editing === undefined ? html`` : section(`プロジェクトの編集: ${editing.project_id}`, editForm)}
    ${milestonesSection}
    ${tasksSection}
    ${section(
      'プロジェクト一覧',
      table,
      'タスクが参照するため物理削除はできません。終わったプロジェクトは状態を「終了」にします(終了にするとタスク指示の分解候補・朝の問いかけのタスク文脈から外れます)。行の「編集」から内容・目的・マイルストーン・タスク進捗を管理できます',
    )}
    ${section('プロジェクトの追加', createForm, undefined, 'create')}
  `;
}

/**
 * 数値 ID(BIGINT 列の識別子)。requireRef は長さしか検証しないため、
 * 非数値が PG の 22P02(→ 500)に落ちる前に 400 で弾く。
 */
function requireNumericId(form: URLSearchParams, field: string, label: string): string {
  const value = requireRef(form, field, label);
  if (!/^\d+$/.test(value)) {
    throw invalidInput(`${label}の指定が不正です。ページを再読み込みしてやり直してください`);
  }
  return value;
}

/** YYYY-MM-DD 形式かつカレンダー上実在する日付か(2026-02-31 等を 500 にせず 400 で弾く)。 */
function isRealDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * フォームからプロジェクト属性を取り出して検証する(create / update 共通)。
 * current: update 時の現在値。status には DDL の CHECK がなく SQL 直登録の値があり得るため、
 * また担当管理者は降格(admin→member)済みの場合があり得るため、どちらも既定の検証に加えて
 * 「現在値の温存」を許可する(原則7。編集フォームの「(現在値)」「(現担当)」選択肢と対)。
 */
async function parseProjectFields(
  pool: pg.Pool,
  form: URLSearchParams,
  current?: { status: string; adminOwnerId: string | null },
): Promise<{
  name: string;
  customerId: string | null;
  projectType: string;
  status: string;
  priority: number | null;
  adminOwnerId: string | null;
  objective: string | null;
  description: string | null;
}> {
  const name = requireText(form, 'name', '名称');
  // 計画情報はすべて任意(v0.10 §2: 詳細に計画されていないプロジェクトを許容する)
  const objective = optionalText(form, 'objective', '目的', 2000);
  const description = optionalText(form, 'description', '内容', 2000);
  const projectType = (form.get('project_type') ?? '').trim();
  if (!isValidChoice(PROJECT_TYPES, projectType)) {
    throw invalidInput('種別の指定が不正です');
  }
  const status = (form.get('status') ?? '').trim();
  if (!isValidChoice(PROJECT_STATUSES, status) && status !== current?.status) {
    throw invalidInput('状態の指定が不正です');
  }
  const priority = optionalInt(form, 'priority', '優先度');
  // 既存マスタを参照するため厳格パターンは適用しない(実在性は FK 制約が担保)
  const customerId = optionalText(form, 'customer_id', '顧客');
  const adminOwnerId = optionalText(form, 'admin_owner_id', '担当管理者');
  // 担当管理者は admin ロールに限定する(FK は ops.users 全体を許すため、
  // フォーム偽装で member を担当管理者にできないようサーバー側でも検証する)。
  // 現担当の温存(降格済みでも変更せず送信できる)は検証をスキップする
  if (adminOwnerId !== null && adminOwnerId !== current?.adminOwnerId) {
    const found = await query(
      pool,
      `SELECT 1 FROM ops.users WHERE user_id = $1 AND role = 'admin'`,
      [adminOwnerId],
    );
    if ((found.rowCount ?? 0) === 0) {
      throw invalidInput('担当管理者は admin ロールのユーザーから選択してください');
    }
  }
  return { name, customerId, projectType, status, priority, adminOwnerId, objective, description };
}

/** プロジェクトへの書込。成功時はリダイレクト先を返す(PRG パターン)。 */
export async function handleAdminProjectsPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');

  if (action === 'create') {
    const projectId = requireId(form, 'project_id', 'プロジェクトID');
    const fields = await parseProjectFields(pool, form, undefined);
    try {
      await query(
        pool,
        `INSERT INTO ops.projects
           (project_id, name, customer_id, project_type, status, priority, admin_owner_id,
            objective, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          projectId,
          fields.name,
          fields.customerId,
          fields.projectType,
          fields.status,
          fields.priority,
          fields.adminOwnerId,
          fields.objective,
          fields.description,
        ],
      );
    } catch (err) {
      if (hasPgCode(err, PG_UNIQUE_VIOLATION)) {
        throw writeConflict(`プロジェクトID「${projectId}」は既に存在します`);
      }
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw invalidInput(
          '存在しない顧客または担当管理者が指定されました。ページを再読み込みしてやり直してください',
        );
      }
      throw err;
    }
    auditLog(viewer, 'project.create', { projectId }, { ...fields });
    return `${PATH}?saved=created#create`;
  }

  if (action === 'update') {
    // 既存レコード参照のため厳格パターンは適用しない(実在性は WHERE 句が担保)
    const projectId = requireRef(form, 'project_id', 'プロジェクトID');
    // 現在の status・担当者を取得し、リスト外/降格済みの既存値の温存を許可する(parseProjectFields 参照)
    const current = await query<{ status: string; admin_owner_id: string | null }>(
      pool,
      `SELECT status, admin_owner_id FROM ops.projects WHERE project_id = $1`,
      [projectId],
    );
    const currentRow = current.rows[0];
    if (currentRow === undefined) {
      throw invalidInput(`プロジェクト「${projectId}」が見つかりません`);
    }
    const fields = await parseProjectFields(pool, form, {
      status: currentRow.status,
      adminOwnerId: currentRow.admin_owner_id,
    });
    let result;
    try {
      result = await query(
        pool,
        `UPDATE ops.projects
         SET name = $2, customer_id = $3, project_type = $4, status = $5,
             priority = $6, admin_owner_id = $7, objective = $8, description = $9,
             updated_at = now()
         WHERE project_id = $1`,
        [
          projectId,
          fields.name,
          fields.customerId,
          fields.projectType,
          fields.status,
          fields.priority,
          fields.adminOwnerId,
          fields.objective,
          fields.description,
        ],
      );
    } catch (err) {
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw invalidInput(
          '存在しない顧客または担当管理者が指定されました。ページを再読み込みしてやり直してください',
        );
      }
      throw err;
    }
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput(`プロジェクト「${projectId}」が見つかりません`);
    }
    auditLog(viewer, 'project.update', { projectId }, { ...fields });
    return `${PATH}?saved=updated`;
  }

  // ── マイルストーン管理(v0.10 §2)────────────────────────────
  // すべての操作で project_id を WHERE 条件に含め、別プロジェクトのマイルストーンを
  // 操作できないようにする(hidden input 偽装への防御・混同防止 — v0.10 §5)

  if (action === 'add_milestone') {
    const projectId = requireRef(form, 'project_id', 'プロジェクトID');
    const title = requireText(form, 'title', 'マイルストーン名');
    const dueDate = optionalText(form, 'due_date', '期日');
    if (dueDate !== null && !isRealDateString(dueDate)) {
      throw invalidInput('期日は YYYY-MM-DD 形式の実在する日付で入力してください');
    }
    try {
      await query(
        pool,
        `INSERT INTO ops.project_milestones (project_id, title, due_date)
         VALUES ($1, $2, $3::date)`,
        [projectId, title, dueDate],
      );
    } catch (err) {
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw invalidInput(`プロジェクト「${projectId}」が見つかりません`);
      }
      throw err;
    }
    auditLog(viewer, 'milestone.create', { projectId }, { title, dueDate });
    return `${PATH}?edit=${encodeURIComponent(projectId)}&saved=created#milestones`;
  }

  if (action === 'toggle_milestone') {
    const projectId = requireRef(form, 'project_id', 'プロジェクトID');
    const milestoneId = requireNumericId(form, 'milestone_id', 'マイルストーン');
    const status = (form.get('status') ?? '').trim();
    if (status !== 'planned' && status !== 'done') {
      throw invalidInput('マイルストーン状態の指定が不正です');
    }
    const result = await query(
      pool,
      `UPDATE ops.project_milestones SET status = $3, updated_at = now()
       WHERE milestone_id = $1 AND project_id = $2`,
      [milestoneId, projectId, status],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput('このプロジェクトのマイルストーンが見つかりません。ページを再読み込みしてやり直してください');
    }
    auditLog(viewer, 'milestone.toggle', { projectId, milestoneId }, { status });
    return `${PATH}?edit=${encodeURIComponent(projectId)}&saved=updated#milestones`;
  }

  if (action === 'delete_milestone') {
    const projectId = requireRef(form, 'project_id', 'プロジェクトID');
    const milestoneId = requireNumericId(form, 'milestone_id', 'マイルストーン');
    const result = await query(
      pool,
      `DELETE FROM ops.project_milestones WHERE milestone_id = $1 AND project_id = $2`,
      [milestoneId, projectId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput('このプロジェクトのマイルストーンが見つかりません。ページを再読み込みしてやり直してください');
    }
    auditLog(viewer, 'milestone.delete', { projectId, milestoneId }, {});
    return `${PATH}?edit=${encodeURIComponent(projectId)}&saved=deleted#milestones`;
  }

  // ── タスク進捗の更新(v0.10 §3)─────────────────────────────
  // 状態の更新のみ(起票・題名・担当・期限の変更は M3 の Chat 承認フローが SoT)。
  // 遷移は ops.task_status_log と同一トランザクションで記録する(tasks.ts と同じ原則)

  if (action === 'update_task_status') {
    const projectId = requireRef(form, 'project_id', 'プロジェクトID');
    const taskId = requireNumericId(form, 'task_id', 'タスク');
    const status = (form.get('status') ?? '').trim();
    if (!isValidChoice(TASK_STATUSES, status)) {
      throw invalidInput('タスク状態の指定が不正です');
    }
    let statusFrom: string | undefined;
    await withTransaction(pool, async (client) => {
      // project_id を条件に含め、別プロジェクトのタスクを更新できないようにする(混同防止)
      const current = await query<{ status: string }>(
        client,
        `SELECT status FROM ops.tasks WHERE task_id = $1 AND project_id = $2 FOR UPDATE`,
        [taskId, projectId],
      );
      statusFrom = current.rows[0]?.status;
      if (statusFrom === undefined) {
        throw invalidInput('このプロジェクトのタスクが見つかりません。ページを再読み込みしてやり直してください');
      }
      if (statusFrom === status) return; // 同一状態への更新は no-op(履歴を汚さない・冪等)
      await query(
        client,
        `UPDATE ops.tasks
         SET status = $2, updated_at = now(),
             completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
         WHERE task_id = $1`,
        [taskId, status],
      );
      await query(
        client,
        `INSERT INTO ops.task_status_log (task_id, status_from, status_to, changed_via)
         VALUES ($1, $2, $3, 'admin')`,
        [taskId, statusFrom, status],
      );
    });
    if (statusFrom !== status) {
      auditLog(viewer, 'task.status_update', { projectId, taskId }, { statusFrom, statusTo: status });
    }
    return `${PATH}?edit=${encodeURIComponent(projectId)}&saved=updated#tasks`;
  }

  throw invalidInput('不明な操作です');
}
