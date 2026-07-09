import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import {
  auditLog,
  hasPgCode,
  invalidInput,
  isChecked,
  optionalInt,
  PG_UNIQUE_VIOLATION,
  requireId,
  requireRef,
  requireText,
  writeConflict,
} from '../../admin/form.js';
import {
  activeBadge,
  adminTabs,
  csrfField,
  flashMessages,
  type AdminPageContext,
} from './common.js';

interface IndustryRow {
  industry_id: string;
  name: string;
  active: boolean;
  display_order: number | null;
  updated: string;
}

const PATH = '/admin/industries';

/**
 * 業界マスタの一覧・追加・編集(要件 v0.3 §5)。
 * 参照整合性のため物理削除はせず、無効化(active=false)で運用する。
 */
export async function renderAdminIndustries(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const industries = await query<IndustryRow>(
    pool,
    `SELECT industry_id, name, active, display_order,
            to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS updated
     FROM ops.industries
     ORDER BY display_order NULLS LAST, industry_id`,
  );

  const editId = ctx.url.searchParams.get('edit');
  const editing = industries.rows.find((r) => r.industry_id === editId);

  const table = responsiveTable(
    [
      { key: 'id', label: '業界ID' },
      { key: 'name', label: '表示名' },
      { key: 'order', label: '表示順', numeric: true },
      { key: 'state', label: '状態' },
      { key: 'updated', label: '更新日時' },
      { key: 'ops', label: '操作' },
    ],
    industries.rows.map((r) => ({
      id: r.industry_id,
      name: r.name,
      order: r.display_order ?? '—',
      state: activeBadge(r.active),
      updated: r.updated,
      ops: raw(`<a href="${h(`${PATH}?edit=${encodeURIComponent(r.industry_id)}`)}">編集</a>`),
    })),
    { emptyText: '業界が登録されていません' },
  );

  const editForm =
    editing === undefined
      ? html``
      : html`<form method="post" action="${PATH}" class="card form">
          ${csrfField(ctx)}
          <input type="hidden" name="action" value="update">
          <input type="hidden" name="industry_id" value="${editing.industry_id}">
          <div class="form-grid">
            <label class="field">業界ID
              <div class="readonly-id">${editing.industry_id}</div>
            </label>
            <label class="field">表示名
              <input type="text" name="name" value="${editing.name}" required maxlength="500">
            </label>
            <label class="field">表示順
              <input type="number" name="display_order" value="${editing.display_order ?? ''}">
            </label>
            <label class="check-row"><input type="checkbox" name="active"${raw(editing.active ? ' checked' : '')}> 有効</label>
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
      <label class="field">業界ID
        <input type="text" name="industry_id" required maxlength="64" pattern="[a-z0-9_\\-]+"
               placeholder="例: retail" title="半角の小文字英数字・ハイフン・アンダースコア">
      </label>
      <label class="field">表示名
        <input type="text" name="name" required maxlength="500" placeholder="例: 小売業">
      </label>
      <label class="field">表示順
        <input type="number" name="display_order" placeholder="例: 10">
      </label>
      <label class="check-row"><input type="checkbox" name="active" checked> 有効</label>
    </div>
    <p class="form-help">
      業界ID はナレッジの Drive フォルダ規約(domain/{業界ID}/)に使われるため、後から変更できません。
    </p>
    <button class="btn" type="submit">追加する</button>
  </form>`;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${editing === undefined ? html`` : section(`業界の編集: ${editing.industry_id}`, editForm)}
    ${section(
      '業界一覧',
      table,
      '業界は直交する軸の組み合わせで表現します(複合業界値は作らない)。物理削除はせず「無効」で運用します',
    )}
    ${section('業界の追加', createForm)}
  `;
}

/** 業界マスタへの書込。成功時はリダイレクト先を返す(PRG パターン)。 */
export async function handleAdminIndustriesPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');

  if (action === 'create') {
    const industryId = requireId(form, 'industry_id', '業界ID');
    const name = requireText(form, 'name', '表示名');
    const displayOrder = optionalInt(form, 'display_order', '表示順');
    const active = isChecked(form, 'active');
    try {
      await query(
        pool,
        `INSERT INTO ops.industries (industry_id, name, display_order, active)
         VALUES ($1, $2, $3, $4)`,
        [industryId, name, displayOrder, active],
      );
    } catch (err) {
      if (hasPgCode(err, PG_UNIQUE_VIOLATION)) {
        throw writeConflict(`業界ID「${industryId}」は既に存在します`);
      }
      throw err;
    }
    auditLog(viewer, 'industry.create', { industryId }, { name, displayOrder, active });
    return `${PATH}?saved=created`;
  }

  if (action === 'update') {
    // 既存レコード参照のため厳格パターンは適用しない(実在性は WHERE 句が担保)
    const industryId = requireRef(form, 'industry_id', '業界ID');
    const name = requireText(form, 'name', '表示名');
    const displayOrder = optionalInt(form, 'display_order', '表示順');
    const active = isChecked(form, 'active');
    const result = await query(
      pool,
      `UPDATE ops.industries
       SET name = $2, display_order = $3, active = $4, updated_at = now()
       WHERE industry_id = $1`,
      [industryId, name, displayOrder, active],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput(`業界「${industryId}」が見つかりません`);
    }
    auditLog(viewer, 'industry.update', { industryId }, { name, displayOrder, active });
    return `${PATH}?saved=updated`;
  }

  throw invalidInput('不明な操作です');
}
