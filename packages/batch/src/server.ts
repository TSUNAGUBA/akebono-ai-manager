import {
  AppError,
  createAppServer,
  ERROR_CODES,
  logger,
  readOptionalJsonBody,
  sendJson,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { verifySchedulerRequest } from './auth.js';
import { runAdhocCheckin } from './jobs/adhoc-checkin.js';
import { runAnomalyScan } from './jobs/anomaly-scan.js';
import { runDailyReport } from './jobs/daily-report.js';
import { runKnowledgeSync } from './jobs/knowledge-sync.js';
import { runMorningCheckin, type JobSummary } from './jobs/morning-checkin.js';
import { runWeeklySummary } from './jobs/weekly-summary.js';

/**
 * ジョブへ渡すリクエストボディ(JSON・空可)のパラメータ。
 * パラメータ非対応のジョブ(定時ジョブ)は第2引数を受け取らないシグネチャのまま
 * JobRunner に代入できる(引数の少ない関数の代入は型互換)ため、既存ジョブは変更不要。
 */
export interface JobParams {
  userId?: string;
}

type JobRunner = (pool: pg.Pool, params: JobParams) => Promise<JobSummary>;

export const JOBS: Record<string, JobRunner> = {
  'morning-checkin': runMorningCheckin,
  'daily-report': runDailyReport,
  'weekly-summary': runWeeklySummary,
  'knowledge-sync': runKnowledgeSync,
  'anomaly-scan': runAnomalyScan,
  'adhoc-checkin': runAdhocCheckin,
};

/** ボディ(未指定可)を JobParams に検証・正規化する。不正は AIM-3103(400)。 */
export function parseJobParams(body: unknown): JobParams {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディは JSON オブジェクトで指定してください', {
      status: 400,
    });
  }
  const { userId } = body as { userId?: unknown };
  if (userId === undefined) return {};
  if (typeof userId !== 'string' || userId.trim() === '' || userId.length > 256) {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'userId は空でない文字列で指定してください', {
      status: 400,
    });
  }
  return { userId: userId.trim() };
}

/**
 * 定時・随時ジョブ実行サービス。Cloud Scheduler(定時)またはダッシュボード(随時)が
 * OIDC トークン付きで POST /jobs/{name} を呼び出す。ボディ(JSON)は任意で、
 * パラメータ対応ジョブ(adhoc-checkin)にのみ意味を持つ。
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
        const params = parseJobParams(await readOptionalJsonBody(req));
        logger.info('ジョブ開始', { job: jobName, ...params });
        try {
          const summary = await runner(pool, params);
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
