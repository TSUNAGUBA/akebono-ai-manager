import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { badge, responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { auditLog, invalidInput, requireRef } from '../../admin/form.js';
import {
  activeBadge,
  adminTabs,
  csrfField,
  flashMessages,
  type AdminPageContext,
} from './common.js';

interface UserRow {
  user_id: string;
  display_name: string;
  role: string;
  active: boolean;
  dm_ready: boolean;
  checkin_enabled: boolean;
}

const PATH = '/admin/users';

/** ロールの表示名。 */
function roleLabel(role: string): string {
  return role === 'admin' ? '管理者' : 'メンバー';
}

/** 問いかけ可否のバッジ。 */
function checkinBadge(enabled: boolean): Raw {
  return enabled ? badge('問いかけ可', 'ok') : badge('問いかけ不可', 'muted');
}

/**
 * ユーザー設定(要件 v0.8): AI からの問いかけ(朝の問いかけ・状況確認)の配信可否を
 * ユーザー単位で設定する。v0.3 §5 でスコープ外とされたユーザーマスタ UI の最初の一部で、
 * 本ページの書込は問いかけ可否列(checkin_enabled)のみに限定する
 * (DB ロール ai_manager_admin_rw も列単位 GRANT で同じ境界を担保する)。
 * ユーザーの追加・編集(名前・ロール等)は従来どおり SQL 運用
 * (scripts/setup/seed-users.sample.sql)を継続する。
 */
export async function renderAdminUsers(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const users = await query<UserRow>(
    pool,
    `SELECT user_id, display_name, role, active,
            (chat_space_id IS NOT NULL) AS dm_ready,
            checkin_enabled
     FROM ops.users
     ORDER BY active DESC, display_name`,
  );

  const toggleForm = (row: UserRow): Raw => {
    const next = row.checkin_enabled ? '0' : '1';
    const label = row.checkin_enabled ? '問いかけを止める' : '問いかけを再開する';
    return raw(`<form method="post" action="${PATH}" class="inline-form">
      ${csrfField(ctx).html}
      <input type="hidden" name="action" value="toggle_checkin">
      <input type="hidden" name="user_id" value="${h(row.user_id)}">
      <input type="hidden" name="enabled" value="${next}">
      <button class="btn" type="submit">${h(label)}</button>
    </form>`);
  };

  const table = responsiveTable(
    [
      { key: 'name', label: '名前' },
      { key: 'role', label: 'ロール' },
      { key: 'state', label: '状態' },
      { key: 'dm', label: 'DM 登録' },
      { key: 'checkin', label: '問いかけ' },
      { key: 'ops', label: '操作' },
    ],
    users.rows.map((row) => ({
      name: row.display_name,
      role: roleLabel(row.role),
      state: activeBadge(row.active),
      dm: row.dm_ready ? badge('登録済み', 'ok') : badge('未登録', 'warn'),
      checkin: checkinBadge(row.checkin_enabled),
      ops: toggleForm(row),
    })),
    { emptyText: 'ユーザーが登録されていません' },
  );

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${section(
      'ユーザーの問いかけ設定',
      table,
      'AI からの問いかけ(朝の問いかけ・状況確認)は「問いかけ可」かつ有効(active)なユーザーに配信されます。ロールに関わらずユーザー単位で設定できます(v0.8)。ユーザーの追加・名前・ロールの変更は SQL 運用(scripts/setup/seed-users.sample.sql)のままです',
    )}
  `;
}

/** ユーザー設定への書込(問いかけ可否のみ)。成功時はリダイレクト先を返す(PRG パターン)。 */
export async function handleAdminUsersPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');

  if (action === 'toggle_checkin') {
    const userId = requireRef(form, 'user_id', '対象ユーザー');
    const enabledRaw = form.get('enabled');
    if (enabledRaw !== '0' && enabledRaw !== '1') {
      throw invalidInput('問いかけ可否の指定が不正です');
    }
    const enabled = enabledRaw === '1';
    // 目標値を明示した更新(盲目的なフリップではない)のため、二重送信でも結果は同じ(冪等)
    const result = await query(pool, `UPDATE ops.users SET checkin_enabled = $2 WHERE user_id = $1`, [
      userId,
      enabled,
    ]);
    if ((result.rowCount ?? 0) === 0) {
      throw invalidInput(`ユーザー「${userId}」が見つかりません。ページを再読み込みしてやり直してください`);
    }
    auditLog(viewer, 'user.checkin_toggle', { userId }, { checkinEnabled: enabled });
    return `${PATH}?saved=updated`;
  }

  throw invalidInput('不明な操作です');
}
