import { createPool, loadAdminDbConfig, logger, startServer } from '@ai-manager/shared';
import { createDashboardServer } from './server.js';

const pool = createPool();

// マスタ管理用の第2プール(要件 v0.3 §5.1: DB ロール分離)。
// DB_ADMIN_USER / DB_ADMIN_PASSWORD が未設定なら undefined となり、
// マスタ管理ページは案内表示に切り替わる(既存の閲覧機能には影響しない)。
const adminDbConfig = loadAdminDbConfig();
const adminPool = adminDbConfig === undefined ? undefined : createPool(adminDbConfig);
if (adminDbConfig === undefined) {
  logger.info('マスタ管理は未構成です(DB_ADMIN_USER / DB_ADMIN_PASSWORD 未設定)。閲覧機能のみで起動します');
} else {
  logger.info('マスタ管理用の管理 DB プールを初期化しました', { user: adminDbConfig.user });
}

startServer(createDashboardServer(pool, adminPool), 'dashboard');
