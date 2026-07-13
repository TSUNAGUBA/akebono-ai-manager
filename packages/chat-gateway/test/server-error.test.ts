import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type pg from 'pg';
import { AppError, ERROR_CODES } from '@ai-manager/shared';

const mocks = vi.hoisted(() => ({
  verifyChatRequest: vi.fn(async () => undefined),
  resolveUser: vi.fn(async () => ({
    user_id: 'member1',
    display_name: '田中',
    email: 'member@example.com',
    role: 'member' as const,
    chat_space_id: null,
    active: true,
  })),
  handleMessage: vi.fn(),
}));

vi.mock('../src/auth.js', () => ({
  verifyChatRequest: mocks.verifyChatRequest,
  resolveUser: mocks.resolveUser,
}));
vi.mock('../src/handlers/message.js', () => ({
  handleMessage: mocks.handleMessage,
}));

const { createChatGatewayServer } = await import('../src/server.js');

const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;

let server: http.Server;
let port: number;

beforeEach(async () => {
  mocks.handleMessage.mockReset();
  server = createChatGatewayServer(pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postMessageEvent(): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'MESSAGE',
      user: { email: 'member@example.com' },
      message: { text: '進捗どうですか', argumentText: '進捗どうですか' },
    }),
  });
  return { status: res.status, body: await res.text() };
}

describe('Chat イベント処理エラー時の汎用フォールバック(v0.9 §5.3)', () => {
  it('AppError はエラーコードを文言に含めて 200 で返す(診断性の向上)', async () => {
    mocks.handleMessage.mockRejectedValueOnce(
      new AppError(ERROR_CODES.LLM_REQUEST_FAILED, 'LLM API 呼び出しに失敗しました'),
    );
    const { status, body } = await postMessageEvent();

    expect(status).toBe(200); // Chat 上の UX を守るため 200+文言
    expect(body).toContain('処理中にエラーが発生しました');
    expect(body).toContain(`(エラーコード: ${ERROR_CODES.LLM_REQUEST_FAILED})`);
  });

  it('想定外のエラー(AppError 以外)はコードなしの文言で返す', async () => {
    mocks.handleMessage.mockRejectedValueOnce(new Error('unexpected'));
    const { status, body } = await postMessageEvent();

    expect(status).toBe(200);
    expect(body).toContain('処理中にエラーが発生しました');
    expect(body).not.toContain('エラーコード');
  });
});
