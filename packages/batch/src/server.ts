import {
  AppError,
  createAppServer,
  ERROR_CODES,
  isAppError,
  logger,
  readOptionalJsonBody,
  sendJson,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { verifySchedulerRequest } from './auth.js';
import { runAdhocCheckin } from './jobs/adhoc-checkin.js';
import { runAnomalyScan } from './jobs/anomaly-scan.js';
import { runDailyEtl } from './jobs/daily-etl.js';
import { runDailyReport } from './jobs/daily-report.js';
import { runDialogueFeedback } from './jobs/dialogue-feedback.js';
import { runEscalationAction } from './jobs/escalation-action.js';
import { runKnowledgeSync } from './jobs/knowledge-sync.js';
import { runMorningCheckin, type JobSummary } from './jobs/morning-checkin.js';
import { runWeeklySummary } from './jobs/weekly-summary.js';

/**
 * ジョブへ渡すリクエストボディ(JSON・空可)のパラメータ。
 * パラメータ非対応のジョブ(定時ジョブ)は第2引数を受け取らないシグネチャのまま
 * JobRunner に代入できる(引数の少ない関数の代入は型互換)ため、既存ジョブは変更不要。
 * 各フィールドの意味・必須判定はジョブ側(adhoc-checkin / daily-etl / escalation-action /
 * dialogue-feedback)で行い、この層は「文字列である」ことのみを保証する。
 */
export interface JobParams {
  userId?: string;
  targetDate?: string;
  escalationId?: string;
  action?: string;
  text?: string;
  operatorUserId?: string;
  dialogueId?: string;
  dialogueCreatedAt?: string;
  feedback?: string;
  feedbackId?: string;
}

type JobRunner = (pool: pg.Pool, params: JobParams) => Promise<JobSummary>;

export const JOBS: Record<string, JobRunner> = {
  'morning-checkin': runMorningCheckin,
  'daily-report': runDailyReport,
  'weekly-summary': runWeeklySummary,
  'knowledge-sync': runKnowledgeSync,
  'anomaly-scan': runAnomalyScan,
  'adhoc-checkin': runAdhocCheckin,
  'daily-etl': runDailyEtl,
  'escalation-action': runEscalationAction,
  'dialogue-feedback': runDialogueFeedback,
};

/** ID・列挙値などの短い文字列フィールド(userId の既存検証と同じ上限)。 */
const ID_FIELDS = [
  'userId',
  'targetDate',
  'escalationId',
  'action',
  'operatorUserId',
  'dialogueId',
  'dialogueCreatedAt',
  'feedbackId',
] as const;
/** 本文系の文字列フィールド。文字数の業務上限(1000/2000)はジョブ側で検証する。 */
const TEXT_FIELDS = ['text', 'feedback'] as const;
const TEXT_FIELD_MAX_LENGTH = 10_000;

/**
 * ボディ(未指定可)を JobParams に検証・正規化する。不正は AIM-3103(400)。
 * unknown の絞り込みのみを担い(空でない文字列・上限長)、必須判定・値の意味の検証は
 * 各ジョブが JOB_PARAMS_INVALID で行う(既存の {userId} 互換は維持)。
 */
export function parseJobParams(body: unknown): JobParams {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, 'リクエストボディは JSON オブジェクトで指定してください', {
      status: 400,
    });
  }
  const record = body as Record<string, unknown>;
  const params: JobParams = {};
  const readField = (name: string, maxLength: number): string | undefined => {
    const value = record[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
      throw new AppError(ERROR_CODES.REQUEST_BODY_INVALID, `${name} は空でない文字列で指定してください`, {
        status: 400,
      });
    }
    return value.trim();
  };
  for (const name of ID_FIELDS) {
    const value = readField(name, 256);
    if (value !== undefined) params[name] = value;
  }
  for (const name of TEXT_FIELDS) {
    const value = readField(name, TEXT_FIELD_MAX_LENGTH);
    if (value !== undefined) params[name] = value;
  }
  return params;
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
          // ジョブ内の想定エラーはコード・ステータスを保ってそのまま返す(JOB_FAILED で
          // 包み直すとレスポンスのコードが AIM-5002 に潰れ、ダッシュボード側でオペレーターに
          // 原因を提示できない)。対象はパラメータ不正等の 4xx と、ジョブ自身の結果を表す
          // ETL_FAILED。下位層由来のエラー(DB 接続断等)は従来どおり JOB_FAILED で包む
          if (isAppError(err) && (err.status < 500 || err.code === ERROR_CODES.ETL_FAILED)) {
            throw err;
          }
          throw new AppError(ERROR_CODES.JOB_FAILED, `ジョブ ${jobName} が失敗しました`, {
            cause: err,
          });
        }
      },
    },
  ]);
}
