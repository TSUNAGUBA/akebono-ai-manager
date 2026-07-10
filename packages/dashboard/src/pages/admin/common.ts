import { h, html, raw, type Raw } from '../../render/html.js';
import { badge } from '../../render/components.js';
import { CSRF_FIELD } from '../../admin/csrf.js';

/** マスタ管理ページの描画コンテキスト。 */
export interface AdminPageContext {
  /** フォームの hidden input に埋め込む CSRF トークン(二重送信クッキー方式) */
  csrfToken: string;
  url: URL;
  /** POST の入力エラーをページ内バナーとして表示する */
  errorMessage?: string;
}

/** マスタ管理の各ページを行き来するサブナビ(タブ)。 */
export function adminTabs(activePath: string): Raw {
  const tabs: Array<{ path: string; label: string }> = [
    { path: '/admin/industries', label: '業界マスタ' },
    { path: '/admin/customers', label: '顧客' },
    { path: '/admin/relations', label: '顧客間関係' },
    { path: '/admin/knowledge', label: 'ナレッジ' },
    { path: '/admin/checkin', label: '状況確認' },
  ];
  const links = tabs
    .map(
      (t) =>
        `<a href="${h(t.path)}"${t.path === activePath ? ' class="active"' : ''}>${h(t.label)}</a>`,
    )
    .join('');
  return raw(`<nav class="subnav">${links}</nav>`);
}

const SAVED_MESSAGES: Record<string, string> = {
  created: '追加しました',
  updated: '更新しました',
  deleted: '削除しました',
};

/** 保存結果(?saved=)と入力エラーのバナー。 */
export function flashMessages(ctx: AdminPageContext): Raw {
  const parts: string[] = [];
  if (ctx.errorMessage !== undefined) {
    parts.push(`<div class="alert error">${h(ctx.errorMessage)}</div>`);
  }
  const saved = ctx.url.searchParams.get('saved');
  // own-property チェック: 継承プロパティ(?saved=toString 等)を成功メッセージとして扱わない
  const message =
    saved !== null && Object.hasOwn(SAVED_MESSAGES, saved) ? SAVED_MESSAGES[saved] : undefined;
  if (message !== undefined) {
    parts.push(`<div class="alert ok">${h(message)}</div>`);
  }
  return raw(parts.join(''));
}

/** 全 POST フォーム必須の CSRF hidden input。 */
export function csrfField(ctx: AdminPageContext): Raw {
  return html`<input type="hidden" name="${CSRF_FIELD}" value="${ctx.csrfToken}">`;
}

/** 有効/無効のバッジ表現(業界・関係種別マスタ共通)。 */
export function activeBadge(active: boolean): Raw {
  return active ? badge('有効', 'ok') : badge('無効', 'muted');
}

/**
 * 管理用 DB 接続が未構成の場合の案内ページ(グレースフルデグラデーション)。
 * 閲覧機能には影響しないことを明示する。
 */
export function renderAdminUnconfigured(): Raw {
  return html`<div class="card">
    <h2 style="margin-top:0">マスタ管理は未構成です</h2>
    <p>
      管理用 DB 接続の環境変数(<strong>DB_ADMIN_USER</strong> / <strong>DB_ADMIN_PASSWORD</strong>)が
      設定されていないため、マスタ管理ページは利用できません。
    </p>
    <p>
      設定手順は <code>docs/operations/deployment-setup.md</code> を参照してください
      (DB ロール <code>ai_manager_admin_rw</code> の作成と、ダッシュボードへの環境変数設定)。
    </p>
    <p class="form-help">閲覧機能(概要・プロジェクト等の各ページ)はこれまでどおり利用できます。</p>
  </div>`;
}
