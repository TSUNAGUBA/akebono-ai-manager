import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { CSRF_FIELD } from '../../admin/csrf.js';
import {
  auditLog,
  invalidInput,
  isChecked,
  isForeignKeyViolation,
  isUniqueViolation,
  optionalText,
  requireId,
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

interface RelationRow {
  from_customer_id: string;
  from_name: string;
  to_customer_id: string;
  to_name: string;
  relation_type: string;
  type_label: string;
  notes: string | null;
  created: string;
}

interface CustomerOption {
  customer_id: string;
  name: string;
}

interface RelationTypeRow {
  relation_type: string;
  label: string;
  active: boolean;
}

const PATH = '/admin/relations';

/**
 * 顧客間関係(有向エッジ)の一覧・追加・削除と、関係種別マスタの追加・編集(要件 v0.3 §5)。
 * 関係はナレッジスコープ導出(§4)の入力になる。向きの意味は関係種別が定義する。
 */
export async function renderAdminRelations(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const relations = await query<RelationRow>(
    pool,
    `SELECT r.from_customer_id, cf.name AS from_name,
            r.to_customer_id, ct.name AS to_name,
            r.relation_type, rt.label AS type_label, r.notes,
            to_char(r.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS created
     FROM ops.customer_relations r
     JOIN ops.customers cf ON cf.customer_id = r.from_customer_id
     JOIN ops.customers ct ON ct.customer_id = r.to_customer_id
     JOIN ops.relation_types rt ON rt.relation_type = r.relation_type
     ORDER BY r.from_customer_id, r.to_customer_id, r.relation_type`,
  );
  const customers = await query<CustomerOption>(
    pool,
    `SELECT customer_id, name FROM ops.customers ORDER BY customer_id`,
  );
  const relationTypes = await query<RelationTypeRow>(
    pool,
    `SELECT relation_type, label, active FROM ops.relation_types ORDER BY relation_type`,
  );

  /** 行ごとの削除ボタン(hidden で複合主キーを渡す)。 */
  const deleteForm = (r: RelationRow): Raw =>
    raw(`<form method="post" action="${PATH}" class="inline-form"
      onsubmit="return confirm('この関係を削除しますか?')">
      <input type="hidden" name="${CSRF_FIELD}" value="${h(ctx.csrfToken)}">
      <input type="hidden" name="action" value="delete_relation">
      <input type="hidden" name="from_customer_id" value="${h(r.from_customer_id)}">
      <input type="hidden" name="to_customer_id" value="${h(r.to_customer_id)}">
      <input type="hidden" name="relation_type" value="${h(r.relation_type)}">
      <button class="btn danger" type="submit">削除</button>
    </form>`);

  const relationTable = responsiveTable(
    [
      { key: 'from', label: 'From(起点)' },
      { key: 'type', label: '関係種別' },
      { key: 'to', label: 'To(相手)' },
      { key: 'notes', label: 'メモ' },
      { key: 'created', label: '登録日' },
      { key: 'ops', label: '操作' },
    ],
    relations.rows.map((r) => ({
      from: `${r.from_name}(${r.from_customer_id})`,
      type: r.type_label,
      to: `${r.to_name}(${r.to_customer_id})`,
      notes: r.notes ?? '—',
      created: r.created,
      ops: deleteForm(r),
    })),
    { emptyText: '顧客間関係が登録されていません' },
  );

  const customerOptions = (selectedNone: string): string =>
    `<option value="">${h(selectedNone)}</option>` +
    customers.rows
      .map((c) => `<option value="${h(c.customer_id)}">${h(`${c.name}(${c.customer_id})`)}</option>`)
      .join('');
  const typeOptions =
    `<option value="">選択してください</option>` +
    relationTypes.rows
      .filter((t) => t.active)
      .map((t) => `<option value="${h(t.relation_type)}">${h(`${t.label}(${t.relation_type})`)}</option>`)
      .join('');

  const createRelationForm = html`<form method="post" action="${PATH}" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="create_relation">
    <div class="form-grid">
      <label class="field">From(起点の顧客)
        <select name="from_customer_id" required>${raw(customerOptions('選択してください'))}</select>
      </label>
      <label class="field">関係種別
        <select name="relation_type" required>${raw(typeOptions)}</select>
      </label>
      <label class="field">To(相手の顧客)
        <select name="to_customer_id" required>${raw(customerOptions('選択してください'))}</select>
      </label>
      <label class="field">メモ
        <input type="text" name="notes" maxlength="500" placeholder="任意">
      </label>
    </div>
    <p class="form-help">
      向きの意味は関係種別が定義します(例: undeux --納品先--> しまむら)。
      関係の業務的な意味はナレッジ文書側に記述してください。
    </p>
    <button class="btn" type="submit">追加する</button>
  </form>`;

  // ── 関係種別マスタ(同ページ内セクション)──
  const editTypeId = ctx.url.searchParams.get('edit_type');
  const editingType = relationTypes.rows.find((t) => t.relation_type === editTypeId);

  const typeTable = responsiveTable(
    [
      { key: 'id', label: '種別ID' },
      { key: 'label', label: '表示名' },
      { key: 'state', label: '状態' },
      { key: 'ops', label: '操作' },
    ],
    relationTypes.rows.map((t) => ({
      id: t.relation_type,
      label: t.label,
      state: activeBadge(t.active),
      ops: raw(`<a href="${h(`${PATH}?edit_type=${encodeURIComponent(t.relation_type)}`)}">編集</a>`),
    })),
    { emptyText: '関係種別が登録されていません' },
  );

  const typeEditForm =
    editingType === undefined
      ? html``
      : html`<form method="post" action="${PATH}" class="card form">
          ${csrfField(ctx)}
          <input type="hidden" name="action" value="update_type">
          <input type="hidden" name="relation_type" value="${editingType.relation_type}">
          <div class="form-grid">
            <label class="field">種別ID
              <div class="readonly-id">${editingType.relation_type}</div>
            </label>
            <label class="field">表示名
              <input type="text" name="label" value="${editingType.label}" required maxlength="500">
            </label>
            <label class="check-row"><input type="checkbox" name="active"${raw(editingType.active ? ' checked' : '')}> 有効</label>
          </div>
          <div class="btn-row">
            <button class="btn" type="submit">更新する</button>
            <a class="btn secondary" href="${PATH}">キャンセル</a>
          </div>
        </form>`;

  const typeCreateForm = html`<form method="post" action="${PATH}" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="create_type">
    <div class="form-grid">
      <label class="field">種別ID
        <input type="text" name="relation_type" required maxlength="64" pattern="[a-z0-9_\\-]+"
               placeholder="例: supplies_to" title="半角の小文字英数字・ハイフン・アンダースコア">
      </label>
      <label class="field">表示名
        <input type="text" name="label" required maxlength="500" placeholder="例: 納品先(メーカー→小売等)">
      </label>
      <label class="check-row"><input type="checkbox" name="active" checked> 有効</label>
    </div>
    <button class="btn" type="submit">追加する</button>
  </form>`;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${section(
      '顧客間関係の一覧',
      relationTable,
      '関係はナレッジ検索のスコープ導出(関係先顧客の固有ナレッジ・業界ナレッジの参照)に使われます',
    )}
    ${section('関係の追加', createRelationForm)}
    ${editingType === undefined
      ? html``
      : section(`関係種別の編集: ${editingType.relation_type}`, typeEditForm)}
    ${section(
      '関係種別マスタ',
      typeTable,
      '参照整合性のため物理削除はせず「無効」で運用します(無効化すると追加フォームの選択肢から外れます)',
    )}
    ${section('関係種別の追加', typeCreateForm)}
  `;
}

/** 顧客間関係・関係種別マスタへの書込。成功時はリダイレクト先を返す。 */
export async function handleAdminRelationsPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');

  if (action === 'create_relation') {
    const fromId = requireId(form, 'from_customer_id', 'From(起点の顧客)');
    const toId = requireId(form, 'to_customer_id', 'To(相手の顧客)');
    const relationType = requireId(form, 'relation_type', '関係種別');
    const notes = optionalText(form, 'notes', 'メモ');
    if (fromId === toId) {
      throw invalidInput('From と To に同じ顧客は指定できません');
    }
    try {
      await query(
        pool,
        `INSERT INTO ops.customer_relations (from_customer_id, to_customer_id, relation_type, notes)
         VALUES ($1, $2, $3, $4)`,
        [fromId, toId, relationType, notes],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw writeConflict('同じ組み合わせの関係は既に登録されています');
      }
      if (isForeignKeyViolation(err)) {
        throw invalidInput('存在しない顧客または関係種別が指定されました。ページを再読み込みしてやり直してください');
      }
      throw err;
    }
    auditLog(
      viewer,
      'relation.create',
      { fromCustomerId: fromId, toCustomerId: toId, relationType },
      { notes },
    );
    return `${PATH}?saved=created`;
  }

  if (action === 'delete_relation') {
    const fromId = requireId(form, 'from_customer_id', 'From(起点の顧客)');
    const toId = requireId(form, 'to_customer_id', 'To(相手の顧客)');
    const relationType = requireId(form, 'relation_type', '関係種別');
    // 既に削除済みでも成功扱い(冪等)。監査ログには結果件数を残す
    const result = await query(
      pool,
      `DELETE FROM ops.customer_relations
       WHERE from_customer_id = $1 AND to_customer_id = $2 AND relation_type = $3`,
      [fromId, toId, relationType],
    );
    auditLog(
      viewer,
      'relation.delete',
      { fromCustomerId: fromId, toCustomerId: toId, relationType },
      { deletedCount: result.rowCount ?? 0 },
    );
    return `${PATH}?saved=deleted`;
  }

  if (action === 'create_type') {
    const relationType = requireId(form, 'relation_type', '種別ID');
    const label = requireText(form, 'label', '表示名');
    const active = isChecked(form, 'active');
    try {
      await query(
        pool,
        `INSERT INTO ops.relation_types (relation_type, label, active) VALUES ($1, $2, $3)`,
        [relationType, label, active],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw writeConflict(`種別ID「${relationType}」は既に存在します`);
      }
      throw err;
    }
    auditLog(viewer, 'relation_type.create', { relationType }, { label, active });
    return `${PATH}?saved=created`;
  }

  if (action === 'update_type') {
    const relationType = requireId(form, 'relation_type', '種別ID');
    const label = requireText(form, 'label', '表示名');
    const active = isChecked(form, 'active');
    const result = await query(
      pool,
      `UPDATE ops.relation_types SET label = $2, active = $3 WHERE relation_type = $1`,
      [relationType, label, active],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput(`関係種別「${relationType}」が見つかりません`);
    }
    auditLog(viewer, 'relation_type.update', { relationType }, { label, active });
    return `${PATH}?saved=updated`;
  }

  throw invalidInput('不明な操作です');
}
