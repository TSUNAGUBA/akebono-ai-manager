import { query, withTransaction } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import {
  auditLog,
  hasPgCode,
  ID_MAX_LENGTH,
  invalidInput,
  optionalText,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  requireId,
  requireRef,
  requireText,
  writeConflict,
} from '../../admin/form.js';
import { adminTabs, csrfField, flashMessages, type AdminPageContext } from './common.js';

interface CustomerRow {
  customer_id: string;
  name: string;
  notes: string | null;
  knowledge_drive_folder_id: string | null;
  industry_ids: string[];
  primary_industry: string | null;
  aliases: string[];
}

interface IndustryOption {
  industry_id: string;
  name: string;
  active: boolean;
}

const PATH = '/admin/customers';

/**
 * 顧客の一覧・追加・編集+所属業界(多対多)と主業界の設定(要件 v0.3 §5)。
 * ops.customers に active 列はないため無効化は対象外(列は追加しない)。
 * 所属業界の SoT は ops.customer_industries。旧 ops.customers.industry 列は
 * 二段階移行(v0.3 §6)の互換用キャッシュとして、主業界を同一トランザクションで追従させる。
 */
export async function renderAdminCustomers(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const customers = await query<CustomerRow>(
    pool,
    `SELECT c.customer_id, c.name, c.notes, c.knowledge_drive_folder_id,
            COALESCE(array_agg(ci.industry_id ORDER BY ci.industry_id)
                     FILTER (WHERE ci.industry_id IS NOT NULL), '{}') AS industry_ids,
            (array_agg(ci.industry_id) FILTER (WHERE ci.is_primary))[1] AS primary_industry,
            COALESCE((SELECT array_agg(a.alias ORDER BY a.alias)
                        FROM ops.customer_aliases a
                       WHERE a.customer_id = c.customer_id), '{}') AS aliases
     FROM ops.customers c
     LEFT JOIN ops.customer_industries ci ON ci.customer_id = c.customer_id
     GROUP BY c.customer_id, c.name, c.notes, c.knowledge_drive_folder_id
     ORDER BY c.customer_id`,
  );
  const industries = await query<IndustryOption>(
    pool,
    `SELECT industry_id, name, active
     FROM ops.industries
     ORDER BY display_order NULLS LAST, industry_id`,
  );

  const industryName = new Map(industries.rows.map((i) => [i.industry_id, i.name]));
  const labelOf = (id: string): string => industryName.get(id) ?? id;

  const editId = ctx.url.searchParams.get('edit');
  const editing = customers.rows.find((r) => r.customer_id === editId);

  const table = responsiveTable(
    [
      { key: 'id', label: '顧客ID' },
      { key: 'name', label: '名称' },
      { key: 'aliases', label: 'エイリアス' },
      { key: 'industries', label: '所属業界(★=主業界)' },
      { key: 'folder', label: 'ナレッジフォルダ' },
      { key: 'ops', label: '操作' },
    ],
    customers.rows.map((r) => ({
      id: r.customer_id,
      name: r.name,
      aliases: r.aliases.length === 0 ? '—' : r.aliases.join('、'),
      industries:
        r.industry_ids.length === 0
          ? '—'
          : r.industry_ids
              .map((id) => (id === r.primary_industry ? `★${labelOf(id)}` : labelOf(id)))
              .join('、'),
      folder: r.knowledge_drive_folder_id === null ? '未設定' : '設定済み',
      ops: raw(`<a href="${h(`${PATH}?edit=${encodeURIComponent(r.customer_id)}`)}">編集</a>`),
    })),
    { emptyText: '顧客が登録されていません' },
  );

  /** 所属業界チェックボックス+主業界ラジオの選択 UI(追加・編集共通)。 */
  const industryPicker = (selected: readonly string[], primary: string | null): Raw => {
    if (industries.rows.length === 0) {
      return html`<p class="form-help">業界マスタが空です。先に業界マスタから業界を追加してください。</p>`;
    }
    const rows = industries.rows
      .map((i) => {
        const checked = selected.includes(i.industry_id) ? ' checked' : '';
        const primaryChecked = i.industry_id === primary ? ' checked' : '';
        const inactive = i.active ? '' : `<span class="sub">(無効)</span>`;
        return `<div class="check-row">
          <input type="checkbox" name="industries" value="${h(i.industry_id)}"${checked}>
          <input type="radio" name="primary_industry" value="${h(i.industry_id)}"${primaryChecked} title="主業界">
          <span>${h(i.name)}</span>${inactive}
        </div>`;
      })
      .join('');
    return raw(
      `<div class="check-grid">${rows}</div>
       <p class="form-help">左のチェック=所属業界(複数可)、右のラジオ=主業界(分析軸。所属業界の中から 1 つ)。</p>`,
    );
  };

  const customerFields = (r: CustomerRow | undefined): Raw => html`
    <label class="field">名称
      <input type="text" name="name" value="${r?.name ?? ''}" required maxlength="500" placeholder="例: 株式会社しまむら">
    </label>
    <label class="field">エイリアス(読点・カンマ区切り)
      <input type="text" name="aliases" value="${(r?.aliases ?? []).join('、')}" maxlength="500"
             placeholder="例: しまむら、シマムラ">
    </label>
    <label class="field">ナレッジ Drive フォルダID
      <input type="text" name="knowledge_drive_folder_id" value="${r?.knowledge_drive_folder_id ?? ''}" maxlength="500" placeholder="任意(参考情報)">
    </label>
    <label class="field field-full">メモ
      <textarea name="notes" rows="5" maxlength="500" placeholder="任意">${r?.notes ?? ''}</textarea>
    </label>
    <p class="form-help">
      エイリアスは質問文からの顧客特定に使う別名(各2文字以上)。名称に法人格(株式会社など)を
      含む場合、質問では通称で言及されるため、通称をエイリアスに登録してください
      (例: 名称「株式会社しまむら」→ エイリアス「しまむら」)。
      ナレッジ Drive フォルダID は参考情報です — ナレッジ同期の対象は共通ナレッジフォルダ
      (KNOWLEDGE_DRIVE_FOLDER_ID)配下の customer/{顧客ID}/ で、この欄では変わりません。
    </p>
  `;

  const editForm =
    editing === undefined
      ? html``
      : html`<form method="post" action="${PATH}" class="card form">
          ${csrfField(ctx)}
          <input type="hidden" name="action" value="update">
          <input type="hidden" name="customer_id" value="${editing.customer_id}">
          <div class="form-grid">
            <label class="field">顧客ID
              <div class="readonly-id">${editing.customer_id}</div>
            </label>
            ${customerFields(editing)}
          </div>
          <label class="field">所属業界と主業界</label>
          ${industryPicker(editing.industry_ids, editing.primary_industry)}
          <div class="btn-row" style="margin-top:14px">
            <button class="btn" type="submit">更新する</button>
            <a class="btn secondary" href="${PATH}">キャンセル</a>
          </div>
        </form>`;

  const createForm = html`<form method="post" action="${PATH}" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="create">
    <div class="form-grid">
      <label class="field">顧客ID
        <input type="text" name="customer_id" required maxlength="64" pattern="[a-z0-9_\\-]+"
               placeholder="例: shimamura" title="半角の小文字英数字・ハイフン・アンダースコア">
      </label>
      ${customerFields(undefined)}
    </div>
    <label class="field">所属業界と主業界</label>
    ${industryPicker([], null)}
    <p class="form-help">
      顧客ID はナレッジの Drive フォルダ規約(customer/{顧客ID}/)に使われるため、後から変更できません。
    </p>
    <button class="btn" type="submit">追加する</button>
  </form>`;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${editing === undefined ? html`` : section(`顧客の編集: ${editing.customer_id}`, editForm)}
    ${section('顧客一覧', table)}
    ${section('顧客の追加', createForm, undefined, 'create')}
  `;
}

/** フォームから所属業界と主業界を取り出して検証する。 */
function parseIndustrySelection(form: URLSearchParams): { industryIds: string[]; primary: string } {
  const industryIds = [...new Set(form.getAll('industries').map((v) => v.trim()))].filter(
    (v) => v !== '',
  );
  if (industryIds.length === 0) {
    throw invalidInput('所属業界を 1 つ以上選択してください');
  }
  // 既存の業界マスタを参照するため厳格パターンは適用しない(実在性は FK 制約が担保)
  for (const id of industryIds) {
    if (id.length > ID_MAX_LENGTH) throw invalidInput('所属業界の指定が不正です');
  }
  const primary = (form.get('primary_industry') ?? '').trim();
  if (primary === '' || !industryIds.includes(primary)) {
    throw invalidInput('主業界は所属業界の中から 1 つ選択してください');
  }
  return { industryIds, primary };
}

/**
 * フォームからエイリアスを取り出して検証する(v0.9 §4)。
 * 読点・カンマ(全角含む)区切り → trim → 空要素除去 → 重複排除。各エイリアスは 2 文字以上
 * (1文字は照合の過剰一致防止のため DDL の CHECK でも拒否される)。
 * 文字数はコードポイントで数える(DDL の length() と同じ基準。サロゲートペア文字を
 * JS の .length で 2 と誤判定して CHECK 違反 → 500 になるのを防ぐ)。
 */
function parseAliases(form: URLSearchParams): string[] {
  const rawValue = form.get('aliases') ?? '';
  if (rawValue.length > 500) throw invalidInput('エイリアスが長すぎます(全体で500文字以内)');
  const aliases = [...new Set(rawValue.split(/[、,,]/).map((v) => v.trim()))].filter(
    (v) => v !== '',
  );
  for (const alias of aliases) {
    if ([...alias].length < 2) {
      throw invalidInput(`エイリアス「${alias}」が短すぎます(2文字以上で指定してください)`);
    }
  }
  return aliases;
}

/** エイリアス(customer_aliases)を単一 INSERT で書き込む(create / update 共通)。 */
async function insertCustomerAliases(
  client: pg.PoolClient,
  customerId: string,
  aliases: readonly string[],
): Promise<void> {
  if (aliases.length === 0) return;
  await query(
    client,
    `INSERT INTO ops.customer_aliases (customer_id, alias)
     SELECT $1, alias FROM unnest($2::text[]) AS t(alias)`,
    [customerId, aliases],
  );
}

/** 所属業界(customer_industries)を単一 INSERT で書き込む(create / update 共通)。 */
async function insertCustomerIndustries(
  client: pg.PoolClient,
  customerId: string,
  industryIds: readonly string[],
  primary: string,
): Promise<void> {
  await query(
    client,
    `INSERT INTO ops.customer_industries (customer_id, industry_id, is_primary)
     SELECT $1, industry_id, is_primary
     FROM unnest($2::text[], $3::boolean[]) AS t(industry_id, is_primary)`,
    [customerId, industryIds, industryIds.map((id) => id === primary)],
  );
}

/** 顧客と所属業界(customer_industries)への書込。成功時はリダイレクト先を返す。 */
export async function handleAdminCustomersPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');

  if (action === 'create') {
    const customerId = requireId(form, 'customer_id', '顧客ID');
    const name = requireText(form, 'name', '名称');
    const notes = optionalText(form, 'notes', 'メモ');
    const folderId = optionalText(form, 'knowledge_drive_folder_id', 'ナレッジ Drive フォルダID');
    const { industryIds, primary } = parseIndustrySelection(form);
    const aliases = parseAliases(form);
    try {
      await withTransaction(pool, async (client) => {
        // 旧 industry 列(NOT NULL・互換用キャッシュ)には主業界を書く(SoT は customer_industries)
        await query(
          client,
          `INSERT INTO ops.customers (customer_id, name, industry, notes, knowledge_drive_folder_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [customerId, name, primary, notes, folderId],
        );
        await insertCustomerIndustries(client, customerId, industryIds, primary);
        await insertCustomerAliases(client, customerId, aliases);
      });
    } catch (err) {
      if (hasPgCode(err, PG_UNIQUE_VIOLATION)) {
        throw writeConflict(`顧客ID「${customerId}」は既に存在します`);
      }
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw invalidInput('存在しない業界が指定されました。ページを再読み込みしてやり直してください');
      }
      throw err;
    }
    auditLog(
      viewer,
      'customer.create',
      { customerId },
      { name, notes, folderId, industryIds, primary, aliases },
    );
    // アンカーで追加フォームへ戻る(連続追加時に最上部へ飛ばされない — v0.11)
    return `${PATH}?saved=created#create`;
  }

  if (action === 'update') {
    // 既存レコード参照のため厳格パターンは適用しない(実在性は WHERE 句が担保)
    const customerId = requireRef(form, 'customer_id', '顧客ID');
    const name = requireText(form, 'name', '名称');
    const notes = optionalText(form, 'notes', 'メモ');
    const folderId = optionalText(form, 'knowledge_drive_folder_id', 'ナレッジ Drive フォルダID');
    const { industryIds, primary } = parseIndustrySelection(form);
    const aliases = parseAliases(form);
    try {
      await withTransaction(pool, async (client) => {
        const updated = await query(
          client,
          `UPDATE ops.customers
           SET name = $2, industry = $3, notes = $4, knowledge_drive_folder_id = $5
           WHERE customer_id = $1`,
          [customerId, name, primary, notes, folderId],
        );
        if ((updated.rowCount ?? 0) === 0) {
          throw invalidInput(`顧客「${customerId}」が見つかりません`);
        }
        // 所属業界・エイリアスは洗い替え(DELETE + INSERT)。同一トランザクション内のため中間状態は見えない
        await query(client, `DELETE FROM ops.customer_industries WHERE customer_id = $1`, [customerId]);
        await insertCustomerIndustries(client, customerId, industryIds, primary);
        await query(client, `DELETE FROM ops.customer_aliases WHERE customer_id = $1`, [customerId]);
        await insertCustomerAliases(client, customerId, aliases);
      });
    } catch (err) {
      if (hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw invalidInput('存在しない業界が指定されました。ページを再読み込みしてやり直してください');
      }
      throw err;
    }
    auditLog(
      viewer,
      'customer.update',
      { customerId },
      { name, notes, folderId, industryIds, primary, aliases },
    );
    return `${PATH}?saved=updated`;
  }

  throw invalidInput('不明な操作です');
}
