import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';

/**
 * /jobs/{name} のリクエストボディ(JSON・空可)がジョブへ渡ることの統合テスト。
 * OIDC 検証と対象ジョブはモックし、ルーティング+ボディ解釈のみを検証する。
 */
const mocks = vi.hoisted(() => ({
  verifySchedulerRequest: vi.fn(async () => undefined),
  runAdhocCheckin: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })),
  runMorningCheckin: vi.fn(async () => ({ sent: 2, skipped: 0, failed: 0 })),
  runDailyEtl: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })),
  runEscalationAction: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })),
  runDialogueFeedback: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })),
}));

vi.mock('../src/auth.js', () => ({ verifySchedulerRequest: mocks.verifySchedulerRequest }));
vi.mock('../src/jobs/adhoc-checkin.js', () => ({ runAdhocCheckin: mocks.runAdhocCheckin }));
vi.mock('../src/jobs/morning-checkin.js', () => ({ runMorningCheckin: mocks.runMorningCheckin }));
vi.mock('../src/jobs/daily-etl.js', () => ({ runDailyEtl: mocks.runDailyEtl }));
vi.mock('../src/jobs/escalation-action.js', () => ({ runEscalationAction: mocks.runEscalationAction }));
vi.mock('../src/jobs/dialogue-feedback.js', () => ({ runDialogueFeedback: mocks.runDialogueFeedback }));

const { createBatchServer, parseJobParams } = await import('../src/server.js');
const { AppError, ERROR_CODES } = await import('@ai-manager/shared');

const stubPool = {} as pg.Pool;

let server: http.Server;
let port: number;

beforeEach(async () => {
  mocks.runAdhocCheckin.mockClear();
  mocks.runMorningCheckin.mockClear();
  mocks.runDailyEtl.mockClear().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
  mocks.runEscalationAction.mockClear().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
  mocks.runDialogueFeedback.mockClear().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
  server = createBatchServer(stubPool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST' },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          data += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body ?? '');
  });
}

describe('POST /jobs/{name} のボディ受け渡し', () => {
  it('JSON ボディの userId をパラメータ対応ジョブへ渡す', async () => {
    const res = await post('/jobs/adhoc-checkin', JSON.stringify({ userId: 'member1' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ job: 'adhoc-checkin', sent: 1, skipped: 0, failed: 0 });
    expect(mocks.runAdhocCheckin).toHaveBeenCalledWith(stubPool, { userId: 'member1' });
  });

  it('空ボディは空パラメータとして渡す(Cloud Scheduler 互換)', async () => {
    const res = await post('/jobs/adhoc-checkin');
    expect(res.status).toBe(200);
    expect(mocks.runAdhocCheckin).toHaveBeenCalledWith(stubPool, {});
  });

  it('既存ジョブは従来どおり動く(パラメータは無視される)', async () => {
    const res = await post('/jobs/morning-checkin');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ job: 'morning-checkin', sent: 2, skipped: 0, failed: 0 });
    expect(mocks.runMorningCheckin).toHaveBeenCalledWith(stubPool, {});
  });

  it('不正 JSON は AIM-3103(400)でジョブを起動しない', async () => {
    const res = await post('/jobs/adhoc-checkin', '{broken');
    expect(res.status).toBe(400);
    expect(res.body).toContain('AIM-3103');
    expect(mocks.runAdhocCheckin).not.toHaveBeenCalled();
  });

  it('userId が文字列でない場合は AIM-3103(400)', async () => {
    const res = await post('/jobs/adhoc-checkin', JSON.stringify({ userId: 5 }));
    expect(res.status).toBe(400);
    expect(res.body).toContain('AIM-3103');
    expect(mocks.runAdhocCheckin).not.toHaveBeenCalled();
  });

  it('不明なジョブ名は AIM-5001(404)', async () => {
    const res = await post('/jobs/no-such-job');
    expect(res.status).toBe(404);
    expect(res.body).toContain('AIM-5001');
  });

  it('daily-etl は targetDate を受け取る(v0.12 §6)', async () => {
    const res = await post('/jobs/daily-etl', JSON.stringify({ targetDate: '2026-07-01' }));
    expect(res.status).toBe(200);
    expect(mocks.runDailyEtl).toHaveBeenCalledWith(stubPool, { targetDate: '2026-07-01' });
  });

  it('escalation-action は escalationId / action / text / operatorUserId を受け取る(v0.12 §3)', async () => {
    const params = { escalationId: '9', action: 'answer', text: '回答本文', operatorUserId: 'admin1' };
    const res = await post('/jobs/escalation-action', JSON.stringify(params));
    expect(res.status).toBe(200);
    expect(mocks.runEscalationAction).toHaveBeenCalledWith(stubPool, params);
  });

  it('dialogue-feedback は新規・再送どちらの形態のパラメータも受け取る(v0.12 §7)', async () => {
    const create = {
      dialogueId: '5',
      dialogueCreatedAt: '2026-07-10T00:00:00.000Z',
      feedback: '正しくは5営業日です。',
      operatorUserId: 'admin1',
    };
    let res = await post('/jobs/dialogue-feedback', JSON.stringify(create));
    expect(res.status).toBe(200);
    expect(mocks.runDialogueFeedback).toHaveBeenCalledWith(stubPool, create);

    const resend = { feedbackId: '10', operatorUserId: 'admin1' };
    res = await post('/jobs/dialogue-feedback', JSON.stringify(resend));
    expect(res.status).toBe(200);
    expect(mocks.runDialogueFeedback).toHaveBeenLastCalledWith(stubPool, resend);

    // 還流のみ再試行(refluxOnly)の形態も通す
    const refluxOnly = { feedbackId: '10', refluxOnly: 'true', operatorUserId: 'admin1' };
    res = await post('/jobs/dialogue-feedback', JSON.stringify(refluxOnly));
    expect(res.status).toBe(200);
    expect(mocks.runDialogueFeedback).toHaveBeenLastCalledWith(stubPool, refluxOnly);
  });

  it('ジョブが投げた AIM-5005(400)はコード・ステータスを保って返す(JOB_FAILED で潰さない)', async () => {
    mocks.runEscalationAction.mockRejectedValue(
      new AppError(ERROR_CODES.JOB_PARAMS_INVALID, 'escalationId は必須です', { status: 400 }),
    );
    const res = await post('/jobs/escalation-action', JSON.stringify({ action: 'answer' }));
    expect(res.status).toBe(400);
    expect(res.body).toContain('AIM-5005');
  });

  it('daily-etl の AIM-5006(500)もコードを保って返す(ジョブ自身の結果コード)', async () => {
    mocks.runDailyEtl.mockRejectedValue(
      new AppError(ERROR_CODES.ETL_FAILED, '集計 ETL の実行に失敗しました'),
    );
    const res = await post('/jobs/daily-etl');
    expect(res.status).toBe(500);
    expect(res.body).toContain('AIM-5006');
  });

  it('ジョブの想定外エラーは従来どおり AIM-5002(500)で包む', async () => {
    mocks.runDailyEtl.mockRejectedValue(new Error('boom'));
    const res = await post('/jobs/daily-etl');
    expect(res.status).toBe(500);
    expect(res.body).toContain('AIM-5002');
  });
});

describe('parseJobParams', () => {
  it('undefined・既知フィールドなしは空パラメータ', () => {
    expect(parseJobParams(undefined)).toEqual({});
    expect(parseJobParams({})).toEqual({});
    expect(parseJobParams({ other: 'x' })).toEqual({});
  });

  it('userId は trim して受け入れる(既存互換)', () => {
    expect(parseJobParams({ userId: '  member1 ' })).toEqual({ userId: 'member1' });
  });

  it('新ジョブの文字列フィールドを trim して通す(必須判定・意味の検証はジョブ側)', () => {
    expect(
      parseJobParams({
        targetDate: '2026-07-01',
        escalationId: ' 9 ',
        action: 'answer',
        text: '回答本文',
        operatorUserId: 'admin1',
        dialogueId: '5',
        dialogueCreatedAt: '2026-07-10T00:00:00.000Z',
        feedback: '正しい内容',
        feedbackId: '10',
        refluxOnly: 'true',
      }),
    ).toEqual({
      targetDate: '2026-07-01',
      escalationId: '9',
      action: 'answer',
      text: '回答本文',
      operatorUserId: 'admin1',
      dialogueId: '5',
      dialogueCreatedAt: '2026-07-10T00:00:00.000Z',
      feedback: '正しい内容',
      feedbackId: '10',
      refluxOnly: 'true',
    });
  });

  it('オブジェクト以外・空文字・長すぎる userId は AIM-3103', () => {
    for (const bad of [[], 'str', 42, { userId: '' }, { userId: '  ' }, { userId: 'a'.repeat(257) }]) {
      expect(() => parseJobParams(bad)).toThrowError(
        expect.objectContaining({ code: 'AIM-3103', status: 400 }),
      );
    }
  });

  it('新フィールドも文字列以外・空文字は AIM-3103(unknown を安全に絞り込む)', () => {
    for (const bad of [
      { escalationId: 9 },
      { action: ['answer'] },
      { text: '' },
      { feedback: 42 },
      { targetDate: null },
      { feedbackId: 'a'.repeat(257) },
    ]) {
      expect(() => parseJobParams(bad)).toThrowError(
        expect.objectContaining({ code: 'AIM-3103', status: 400 }),
      );
    }
  });
});
