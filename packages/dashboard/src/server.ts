import {
  createAppServer,
  isAppError,
  logger,
  sendHtml,
  sendText,
  type Route,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { authenticateViewer, requireAdmin } from './auth.js';
import { renderCost } from './pages/cost.js';
import { renderGrowth } from './pages/growth.js';
import { renderMe } from './pages/me.js';
import { renderOverview } from './pages/overview.js';
import { renderProjects } from './pages/projects.js';
import { renderWorkload } from './pages/workload.js';
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

export function createDashboardServer(pool: pg.Pool): http.Server {
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
  ];
  return createAppServer(routes);
}
