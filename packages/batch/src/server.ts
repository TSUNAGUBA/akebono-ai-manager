import {
  AppError,
  createAppServer,
  ERROR_CODES,
  logger,
  sendJson,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { verifySchedulerRequest } from './auth.js';
import { runDailyReport } from './jobs/daily-report.js';
import { runKnowledgeSync } from './jobs/knowledge-sync.js';
import { runMorningCheckin, type JobSummary } from './jobs/morning-checkin.js';
import { runWeeklySummary } from './jobs/weekly-summary.js';

type JobRunner = (pool: pg.Pool) => Promise<JobSummary>;

export const JOBS: Record<string, JobRunner> = {
  'morning-checkin': runMorningCheckin,
  'daily-report': runDailyReport,
  'weekly-summary': runWeeklySummary,
  'knowledge-sync': runKnowledgeSync,
};

/**
 * 定時ジョブ実行サービス。Cloud Scheduler が OIDC トークン付きで
 * POST /jobs/{name} を呼び出す。
 */
export function createBatchServer(pool: pg.Pool): http.Server {
  return createAppServer([
    {
      method: 'POST',
      path: /^\/jobs\/(?<job>[a-z-]+)$/,
      handler: async (req, res, ctx) => {
        await verifySchedulerRequest(req);
        const jobName = ctx.params['job'] ?? '';
        const runner = JOBS[jobName];
        if (runner === undefined) {
          throw new AppError(ERROR_CODES.JOB_UNKNOWN, `不明なジョブです: ${jobName}`, {
            status: 404,
          });
        }
        logger.info('ジョブ開始', { job: jobName });
        try {
          const summary = await runner(pool);
          logger.info('ジョブ完了', { job: jobName, ...summary });
          sendJson(res, 200, { job: jobName, ...summary });
        } catch (err) {
          throw new AppError(ERROR_CODES.JOB_FAILED, `ジョブ ${jobName} が失敗しました`, {
            cause: err,
          });
        }
      },
    },
  ]);
}
