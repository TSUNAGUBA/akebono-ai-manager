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
}));

vi.mock('../src/auth.js', () => ({ verifySchedulerRequest: mocks.verifySchedulerRequest }));
vi.mock('../src/jobs/adhoc-checkin.js', () => ({ runAdhocCheckin: mocks.runAdhocCheckin }));
vi.mock('../src/jobs/morning-checkin.js', () => ({ runMorningCheckin: mocks.runMorningCheckin }));

const { createBatchServer, parseJobParams } = await import('../src/server.js');

const stubPool = {} as pg.Pool;

let server: http.Server;
let port: number;

beforeEach(async () => {
  mocks.runAdhocCheckin.mockClear();
  mocks.runMorningCheckin.mockClear();
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
});

describe('parseJobParams', () => {
  it('undefined・userId なしは空パラメータ', () => {
    expect(parseJobParams(undefined)).toEqual({});
    expect(parseJobParams({})).toEqual({});
    expect(parseJobParams({ other: 'x' })).toEqual({});
  });

  it('userId は trim して受け入れる', () => {
    expect(parseJobParams({ userId: '  member1 ' })).toEqual({ userId: 'member1' });
  });

  it('オブジェクト以外・空文字・長すぎる userId は AIM-3103', () => {
    for (const bad of [[], 'str', 42, { userId: '' }, { userId: '  ' }, { userId: 'a'.repeat(257) }]) {
      expect(() => parseJobParams(bad)).toThrowError(
        expect.objectContaining({ code: 'AIM-3103', status: 400 }),
      );
    }
  });
});
