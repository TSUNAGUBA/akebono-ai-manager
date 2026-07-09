import { h, html, raw, Raw } from './html.js';

export interface Viewer {
  userId: string;
  displayName: string;
  email: string;
  role: 'admin' | 'member';
}

export interface NavItem {
  path: string;
  label: string;
  adminOnly?: boolean;
  /** このプレフィックスに一致するパスでもアクティブ表示する(サブページを持つ項目用) */
  matchPrefix?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '概要' },
  { path: '/projects', label: 'プロジェクト' },
  { path: '/workload', label: 'タスク負荷' },
  { path: '/me', label: 'わたしの振り返り' },
  { path: '/growth', label: '成長観察', adminOnly: true },
  { path: '/cost', label: 'AIコスト', adminOnly: true },
  { path: '/admin/industries', label: 'マスタ管理', adminOnly: true, matchPrefix: '/admin/' },
];

/** 全ページ共通のシェル。ナビゲーションはロールに応じて出し分ける。 */
export function pageLayout(options: {
  title: string;
  description?: string;
  activePath: string;
  viewer: Viewer;
  body: Raw;
}): string {
  const nav = NAV_ITEMS.filter((item) => item.adminOnly !== true || options.viewer.role === 'admin')
    .map((item) => {
      const isActive =
        item.path === options.activePath ||
        (item.matchPrefix !== undefined && options.activePath.startsWith(item.matchPrefix));
      return `<a href="${h(item.path)}"${isActive ? ' class="active"' : ''}>${h(item.label)}</a>`;
    })
    .join('');

  const roleLabel = options.viewer.role === 'admin' ? '管理者' : 'メンバー';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(options.title)} | AKEBONO AI Manager</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="site-header">
  <div class="inner">
    <span class="brand">AKEBONO<span class="dot">・</span>AI Manager</span>
    <nav class="nav">${nav}</nav>
    <span class="viewer">${h(options.viewer.displayName)}(${h(roleLabel)})</span>
  </div>
</header>
<main class="container">
  <h1 class="page-title">${h(options.title)}</h1>
  ${options.description === undefined ? '' : `<p class="page-desc">${h(options.description)}</p>`}
  ${options.body.html}
</main>
</body>
</html>`;
}

/** 認証エラー等の簡易ページ(ナビなし)。 */
export function errorPage(status: number, title: string, message: string): string {
  const body = html`<div class="error-page card">
    <div class="code">${status}</div>
    <h1 class="page-title">${title}</h1>
    <p class="page-desc">${message}</p>
  </div>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)} | AKEBONO AI Manager</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>${raw(body.html).html}</body>
</html>`;
}
