import {
  createAppServer,
  ERROR_CODES,
  isAppError,
  logger,
  readFormBody,
  sendHtml,
  sendText,
  type Route,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { authenticateViewer, requireAdmin } from './auth.js';
import { ensureCsrfToken, verifyCsrfToken } from './admin/csrf.js';
import { renderCost } from './pages/cost.js';
import { renderGrowth } from './pages/growth.js';
import { renderMe } from './pages/me.js';
import { renderOverview } from './pages/overview.js';
import { renderProjects } from './pages/projects.js';
import { renderWorkload } from './pages/workload.js';
import { renderAdminUnconfigured, type AdminPageContext } from './pages/admin/common.js';
import { handleAdminCustomersPost, renderAdminCustomers } from './pages/admin/customers.js';
import { handleAdminIndustriesPost, renderAdminIndustries } from './pages/admin/industries.js';
import { handleAdminRelationsPost, renderAdminRelations } from './pages/admin/relations.js';
import type { Raw } from './render/html.js';
import { errorPage, pageLayout, type Viewer } from './render/layout.js';
import { STYLESHEET } from './render/style.js';

interface PageDef {
  path: string;
  title: string;
  description: string;
  adminOnly?: boolean;
  render: (pool: pg.Pool, viewer: Viewer) => Promise<Raw>;
}

const PAGES: PageDef[] = [
  {
    path: '/',
    title: '概要',
    description: 'チーム全体の今日の状態と、判断が必要な事項',
    render: (pool) => renderOverview(pool),
  },
  {
    path: '/projects',
    title: 'プロジェクト',
    description: 'プロジェクト横断の進捗とヘルス',
    render: (pool) => renderProjects(pool),
  },
  {
    path: '/workload',
    title: 'タスク負荷',
    description: 'メンバー別の負荷と朝夕の問答の実施状況',
    render: (pool) => renderWorkload(pool),
  },
  {
    path: '/me',
    title: 'わたしの振り返り',
    description: 'あなたの予想と結果の差分履歴(本人だけの振り返り資産)',
    render: (pool, viewer) => renderMe(pool, viewer),
  },
  {
    path: '/growth',
    title: '成長観察',
    description: '仮説形成の推移と AI 提案の採否パターン(管理者の観察補助)',
    adminOnly: true,
    render: (pool) => renderGrowth(pool),
  },
  {
    path: '/cost',
    title: 'AIコスト',
    description: 'モデルルーティングの実測とコスト監視',
    adminOnly: true,
    render: (pool) => renderCost(pool),
  },
];

/**
 * マスタ管理ページ(要件 v0.3 §5)。
 * 管理者限定+専用の管理用プール(ai_manager_admin_rw)経由の二重制御(§5.1)。
 * 書込(POST)は CSRF トークン検証(二重送信クッキー)を必須とする。
 */
interface AdminPageDef {
  path: string;
  title: string;
  description: string;
  render: (adminPool: pg.Pool, ctx: AdminPageContext) => Promise<Raw>;
  handlePost: (adminPool: pg.Pool, viewer: Viewer, form: URLSearchParams) => Promise<string>;
}

const ADMIN_PAGES: AdminPageDef[] = [
  {
    path: '/admin/industries',
    title: 'マスタ管理: 業界',
    description: '業界マスタの一覧・追加・編集(物理削除はせず無効化で運用)',
    render: renderAdminIndustries,
    handlePost: handleAdminIndustriesPost,
  },
  {
    path: '/admin/customers',
    title: 'マスタ管理: 顧客',
    description: '顧客の一覧・追加・編集と所属業界(複数)・主業界の設定',
    render: renderAdminCustomers,
    handlePost: handleAdminCustomersPost,
  },
  {
    path: '/admin/relations',
    title: 'マスタ管理: 顧客間関係',
    description: '顧客間関係(有向)の一覧・追加・削除と関係種別マスタの管理',
    render: renderAdminRelations,
    handlePost: handleAdminRelationsPost,
  },
];

function pageRoute(pool: pg.Pool, def: PageDef): Route {
  return {
    method: 'GET',
    path: def.path,
    handler: async (req, res) => {
      let viewer: Viewer;
      try {
        viewer = await authenticateViewer(req, pool);
        if (def.adminOnly === true) requireAdmin(viewer);
      } catch (err) {
        respondError(res, err);
        return;
      }
      try {
        const body = await def.render(pool, viewer);
        sendHtml(
          res,
          200,
          pageLayout({
            title: def.title,
            description: def.description,
            activePath: def.path,
            viewer,
            body,
          }),
        );
      } catch (err) {
        logger.error('ページ描画に失敗しました', err, { path: def.path });
        sendHtml(
          res,
          500,
          errorPage(500, 'エラーが発生しました', 'データの取得に失敗しました。時間をおいて再度お試しください。'),
        );
      }
    },
  };
}

function respondError(res: http.ServerResponse, err: unknown): void {
  if (isAppError(err) && (err.status === 401 || err.status === 403)) {
    logger.warn('ダッシュボード認証エラー', { code: err.code, message: err.message });
    sendHtml(
      res,
      err.status,
      errorPage(err.status, err.status === 401 ? '認証が必要です' : 'アクセスできません', err.message),
    );
    return;
  }
  logger.error('ダッシュボード認証処理でエラー', err);
  sendHtml(res, 500, errorPage(500, 'エラーが発生しました', '認証処理に失敗しました。'));
}

/** 認証+管理者ガード。失敗時は自身でレスポンスを返し undefined を返す。 */
async function authenticateAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
): Promise<Viewer | undefined> {
  try {
    const viewer = await authenticateViewer(req, pool);
    requireAdmin(viewer);
    return viewer;
  } catch (err) {
    respondError(res, err);
    return undefined;
  }
}

function renderAdminShell(def: AdminPageDef, viewer: Viewer, body: Raw): string {
  return pageLayout({
    title: def.title,
    description: def.description,
    activePath: def.path,
    viewer,
    body,
  });
}

function adminGetRoute(pool: pg.Pool, adminPool: pg.Pool | undefined, def: AdminPageDef): Route {
  return {
    method: 'GET',
    path: def.path,
    handler: async (req, res, ctx) => {
      const viewer = await authenticateAdmin(req, res, pool);
      if (viewer === undefined) return;
      if (adminPool === undefined) {
        // グレースフルデグラデーション: 管理用接続が未構成でも閲覧機能は影響を受けない
        sendHtml(res, 200, renderAdminShell(def, viewer, renderAdminUnconfigured()));
        return;
      }
      try {
        const csrfToken = ensureCsrfToken(req, res);
        const body = await def.render(adminPool, { csrfToken, url: ctx.url });
        sendHtml(res, 200, renderAdminShell(def, viewer, body));
      } catch (err) {
        logger.error('ページ描画に失敗しました', err, { path: def.path });
        sendHtml(
          res,
          500,
          errorPage(500, 'エラーが発生しました', 'データの取得に失敗しました。時間をおいて再度お試しください。'),
        );
      }
    },
  };
}

function adminPostRoute(pool: pg.Pool, adminPool: pg.Pool | undefined, def: AdminPageDef): Route {
  return {
    method: 'POST',
    path: def.path,
    handler: async (req, res, ctx) => {
      const viewer = await authenticateAdmin(req, res, pool);
      if (viewer === undefined) return;
      if (adminPool === undefined) {
        logger.warn('マスタ管理が未構成の状態で書込リクエストを受信しました', {
          errorCode: ERROR_CODES.ADMIN_DB_NOT_CONFIGURED,
          path: def.path,
          operator: viewer.email,
        });
        sendHtml(res, 503, renderAdminShell(def, viewer, renderAdminUnconfigured()));
        return;
      }

      // 全 POST に CSRF トークン必須(要件 v0.3 §5.1)
      let form: URLSearchParams;
      try {
        form = await readFormBody(req);
        verifyCsrfToken(req.headers.cookie, form);
      } catch (err) {
        respondError(res, err);
        return;
      }

      try {
        const location = await def.handlePost(adminPool, viewer, form);
        // PRG パターン: 再読み込みによる二重送信を防ぐ
        res.writeHead(303, { location });
        res.end();
      } catch (err) {
        if (isAppError(err) && err.status < 500) {
          // 入力エラー・競合はページ内バナーとして表示する
          logger.warn('マスタ管理の入力エラー', {
            code: err.code,
            message: err.message,
            path: def.path,
            operator: viewer.email,
          });
          try {
            const csrfToken = ensureCsrfToken(req, res);
            const body = await def.render(adminPool, {
              csrfToken,
              url: ctx.url,
              errorMessage: err.message,
            });
            sendHtml(res, err.status, renderAdminShell(def, viewer, body));
          } catch (renderErr) {
            logger.error('ページ描画に失敗しました', renderErr, { path: def.path });
            sendHtml(
              res,
              500,
              errorPage(500, 'エラーが発生しました', 'データの取得に失敗しました。時間をおいて再度お試しください。'),
            );
          }
          return;
        }
        logger.error('マスタ管理の書込に失敗しました', err, {
          path: def.path,
          operator: viewer.email,
        });
        sendHtml(
          res,
          500,
          errorPage(500, 'エラーが発生しました', '変更の保存に失敗しました。時間をおいて再度お試しください。'),
        );
      }
    },
  };
}

export function createDashboardServer(pool: pg.Pool, adminPool?: pg.Pool): http.Server {
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/assets/style.css',
      handler: (_req, res) => {
        sendText(res, 200, STYLESHEET, 'text/css; charset=utf-8', {
          'cache-control': 'public, max-age=300',
        });
      },
    },
    ...PAGES.map((def) => pageRoute(pool, def)),
    ...ADMIN_PAGES.flatMap((def) => [
      adminGetRoute(pool, adminPool, def),
      adminPostRoute(pool, adminPool, def),
    ]),
  ];
  return createAppServer(routes);
}
