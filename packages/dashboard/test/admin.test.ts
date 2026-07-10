import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { ERROR_CODES, isAppError } from '@ai-manager/shared';
import {
  CSRF_COOKIE,
  CSRF_FIELD,
  ensureCsrfToken,
  parseCookies,
  verifyCsrfToken,
} from '../src/admin/csrf.js';
import {
  hasPgCode,
  ID_PATTERN,
  isChecked,
  optionalInt,
  optionalText,
  requireId,
  requireRef,
  requireText,
} from '../src/admin/form.js';
import { renderAdminIndustries } from '../src/pages/admin/industries.js';
import { handleAdminCustomersPost } from '../src/pages/admin/customers.js';
import { handleAdminIndustriesPost } from '../src/pages/admin/industries.js';
import { handleAdminRelationsPost } from '../src/pages/admin/relations.js';
import { pageLayout, type Viewer } from '../src/render/layout.js';
import { createDashboardServer } from '../src/server.js';

const VALID_TOKEN = 'a'.repeat(64);
const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };

function expectAppError(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(isAppError(err), 'AppError であること').toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
    return;
  }
  expect.fail('例外が発生しませんでした');
}

async function expectAppErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
  messageContains?: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(isAppError(err), 'AppError であること').toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      if (messageContains !== undefined) {
        expect(err.message).toContain(messageContains);
      }
    }
    return;
  }
  expect.fail('例外が発生しませんでした');
}

describe('CSRF(二重送信クッキー方式)', () => {
  it('parseCookies: Cookie ヘッダーを分解する', () => {
    expect(parseCookies(`x=1; ${CSRF_COOKIE}=${VALID_TOKEN}; y=2`)).toEqual({
      x: '1',
      [CSRF_COOKIE]: VALID_TOKEN,
      y: '2',
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('verifyCsrfToken: クッキーと hidden input が一致すれば通過する', () => {
    const form = new URLSearchParams({ [CSRF_FIELD]: VALID_TOKEN });
    expect(() => verifyCsrfToken(`${CSRF_COOKIE}=${VALID_TOKEN}`, form)).not.toThrow();
  });

  it('verifyCsrfToken: クッキーがなければ AIM-6003(403)', () => {
    const form = new URLSearchParams({ [CSRF_FIELD]: VALID_TOKEN });
    expectAppError(() => verifyCsrfToken(undefined, form), ERROR_CODES.CSRF_TOKEN_INVALID, 403);
  });

  it('verifyCsrfToken: hidden input がなければ AIM-6003(403)', () => {
    expectAppError(
      () => verifyCsrfToken(`${CSRF_COOKIE}=${VALID_TOKEN}`, new URLSearchParams()),
      ERROR_CODES.CSRF_TOKEN_INVALID,
      403,
    );
  });

  it('verifyCsrfToken: 不一致なら AIM-6003(403)', () => {
    const form = new URLSearchParams({ [CSRF_FIELD]: 'b'.repeat(64) });
    expectAppError(
      () => verifyCsrfToken(`${CSRF_COOKIE}=${VALID_TOKEN}`, form),
      ERROR_CODES.CSRF_TOKEN_INVALID,
      403,
    );
  });

  it('verifyCsrfToken: 形式不正(hex64 以外)なら AIM-6003(403)', () => {
    const form = new URLSearchParams({ [CSRF_FIELD]: 'short' });
    expectAppError(
      () => verifyCsrfToken(`${CSRF_COOKIE}=short`, form),
      ERROR_CODES.CSRF_TOKEN_INVALID,
      403,
    );
  });

  function mockReqRes(cookie?: string): {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    headers: Record<string, string[]>;
  } {
    const headers: Record<string, string[]> = {};
    const req = { headers: cookie === undefined ? {} : { cookie } } as http.IncomingMessage;
    const res = {
      // 実装は appendHeader を使う(既存の Set-Cookie を上書きしない)
      appendHeader: (name: string, value: string) => {
        const key = name.toLowerCase();
        headers[key] = [...(headers[key] ?? []), value];
      },
    } as unknown as http.ServerResponse;
    return { req, res, headers };
  }

  it('ensureCsrfToken: クッキーがなければ新規発行して Set-Cookie する(__Host- 要件: Secure / Path=/)', () => {
    const { req, res, headers } = mockReqRes();
    const token = ensureCsrfToken(req, res);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(CSRF_COOKIE.startsWith('__Host-')).toBe(true);
    const setCookie = (headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toContain(`${CSRF_COOKIE}=${token}`);
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/;');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain('HttpOnly');
  });

  it('ensureCsrfToken: 有効なクッキーがあれば再利用する(複数タブを壊さない)', () => {
    const { req, res, headers } = mockReqRes(`${CSRF_COOKIE}=${VALID_TOKEN}`);
    expect(ensureCsrfToken(req, res)).toBe(VALID_TOKEN);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('ensureCsrfToken: 形式不正なクッキーは無視して再発行する', () => {
    const { req, res, headers } = mockReqRes(`${CSRF_COOKIE}=broken`);
    const token = ensureCsrfToken(req, res);
    expect(token).not.toBe('broken');
    expect((headers['set-cookie'] ?? []).join('\n')).toContain(`${CSRF_COOKIE}=${token}`);
  });

  it('ensureCsrfToken: 既存の Set-Cookie ヘッダーへ追記する(上書きしない)', () => {
    const { req, res, headers } = mockReqRes();
    res.appendHeader('set-cookie', 'other=1');
    const token = ensureCsrfToken(req, res);
    expect(headers['set-cookie']).toHaveLength(2);
    expect(headers['set-cookie']?.[0]).toBe('other=1');
    expect(headers['set-cookie']?.[1]).toContain(`${CSRF_COOKIE}=${token}`);
  });
});

describe('マスタ管理フォームの入力検証', () => {
  const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields);

  it('requireId: ^[a-z0-9_-]+$ を受け入れる', () => {
    expect(requireId(form({ id: 'apparel-retail_01' }), 'id', 'ID')).toBe('apparel-retail_01');
    expect(requireId(form({ id: '  retail  ' }), 'id', 'ID')).toBe('retail');
  });

  it('requireId: 大文字・空白・日本語・記号は AIM-6004(400)', () => {
    for (const bad of ['Retail', 'a b', '小売', 'a/b', 'a.b', '']) {
      expectAppError(() => requireId(form({ id: bad }), 'id', 'ID'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
    }
  });

  it('requireId: 64 文字超は AIM-6004(400)', () => {
    expectAppError(
      () => requireId(form({ id: 'a'.repeat(65) }), 'id', 'ID'),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('requireRef: 既存参照IDはパターン検証しない(非空+長さ上限のみ)', () => {
    // パターン外の既存 ID(大文字・空白・日本語等)も操作対象として受け入れる
    expect(requireRef(form({ id: 'Legacy Customer' }), 'id', 'ID')).toBe('Legacy Customer');
    expect(requireRef(form({ id: '  小売 ' }), 'id', 'ID')).toBe('小売');
  });

  it('requireRef: 空・64 文字超は AIM-6004(400)', () => {
    expectAppError(() => requireRef(form({ id: '' }), 'id', 'ID'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
    expectAppError(() => requireRef(form({}), 'id', 'ID'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
    expectAppError(
      () => requireRef(form({ id: 'a'.repeat(65) }), 'id', 'ID'),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('requireText / optionalText: 必須と任意・長さ上限', () => {
    expect(requireText(form({ name: ' 小売業 ' }), 'name', '表示名')).toBe('小売業');
    expectAppError(() => requireText(form({}), 'name', '表示名'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
    expect(optionalText(form({}), 'notes', 'メモ')).toBeNull();
    expect(optionalText(form({ notes: '' }), 'notes', 'メモ')).toBeNull();
    expectAppError(
      () => optionalText(form({ notes: 'x'.repeat(501) }), 'notes', 'メモ'),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('optionalInt: 空は null、整数以外は AIM-6004(400)', () => {
    expect(optionalInt(form({}), 'order', '表示順')).toBeNull();
    expect(optionalInt(form({ order: '10' }), 'order', '表示順')).toBe(10);
    expect(optionalInt(form({ order: '-1' }), 'order', '表示順')).toBe(-1);
    expectAppError(() => optionalInt(form({ order: 'x' }), 'order', '表示順'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
    expectAppError(() => optionalInt(form({ order: '1.5' }), 'order', '表示順'), ERROR_CODES.ADMIN_INPUT_INVALID, 400);
  });

  it('isChecked: チェックボックスの有無を判定する', () => {
    expect(isChecked(form({ active: 'on' }), 'active')).toBe(true);
    expect(isChecked(form({}), 'active')).toBe(false);
  });

  it('ID_PATTERN が要件の正規表現と一致する', () => {
    expect(ID_PATTERN.source).toBe('^[a-z0-9_-]+$');
  });
});

/** 何を投げるか・何件更新されたことにするかを差し替えられるスタブプール。 */
function stubPool(behavior?: { rejectWith?: unknown; rowCount?: number }): pg.Pool {
  const query = () =>
    behavior?.rejectWith !== undefined
      ? Promise.reject(behavior.rejectWith)
      : Promise.resolve({ rows: [], rowCount: behavior?.rowCount ?? 1 });
  return {
    query,
    connect: () => Promise.resolve({ query, release: () => undefined }),
  } as unknown as pg.Pool;
}

function pgError(code: string): Error {
  const err = new Error('duplicate key value violates unique constraint');
  (err as Error & { code: string }).code = code;
  return err;
}

describe('マスタ管理の書込ハンドラ', () => {
  it('industries: 不正な業界IDは DB に書き込まず AIM-6004(400)', async () => {
    let queried = false;
    const pool = {
      query: () => {
        queried = true;
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as pg.Pool;
    await expectAppErrorAsync(
      () =>
        handleAdminIndustriesPost(
          pool,
          viewer,
          new URLSearchParams({ action: 'create', industry_id: 'Retail!', name: '小売業' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
    expect(queried).toBe(false);
  });

  it('industries: 一意制約違反(23505)は AIM-6005(409)に変換する', async () => {
    expect(hasPgCode(pgError('23505'), '23505')).toBe(false); // 生の pg エラーは対象外(query() が包んだ AppError の cause を見る)
    await expectAppErrorAsync(
      () =>
        handleAdminIndustriesPost(
          stubPool({ rejectWith: pgError('23505') }),
          viewer,
          new URLSearchParams({ action: 'create', industry_id: 'retail', name: '小売業' }),
        ),
      ERROR_CODES.ADMIN_WRITE_CONFLICT,
      409,
    );
  });

  it('industries: 不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminIndustriesPost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('customers: 所属業界の未選択は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminCustomersPost(
          stubPool(),
          viewer,
          new URLSearchParams({ action: 'create', customer_id: 'c1', name: '顧客' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('customers: 主業界が所属業界に含まれない場合は AIM-6004(400)', async () => {
    const form = new URLSearchParams({
      action: 'create',
      customer_id: 'c1',
      name: '顧客',
      primary_industry: 'maker',
    });
    form.append('industries', 'retail');
    await expectAppErrorAsync(
      () => handleAdminCustomersPost(stubPool(), viewer, form),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('relations: From と To が同一顧客なら AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminRelationsPost(
          stubPool(),
          viewer,
          new URLSearchParams({
            action: 'create_relation',
            from_customer_id: 'c1',
            to_customer_id: 'c1',
            relation_type: 'supplies_to',
          }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('relations: 重複登録(23505)は AIM-6005(409)に変換する', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminRelationsPost(
          stubPool({ rejectWith: pgError('23505') }),
          viewer,
          new URLSearchParams({
            action: 'create_relation',
            from_customer_id: 'c1',
            to_customer_id: 'c2',
            relation_type: 'supplies_to',
          }),
        ),
      ERROR_CODES.ADMIN_WRITE_CONFLICT,
      409,
    );
  });

  it('industries: update 対象が存在しない(rowCount=0)場合は AIM-6004(400・見つかりません)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminIndustriesPost(
          stubPool({ rowCount: 0 }),
          viewer,
          new URLSearchParams({ action: 'update', industry_id: 'ghost', name: '小売業' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('customers: update 対象が存在しない(rowCount=0)場合は AIM-6004(400・見つかりません)', async () => {
    const form = new URLSearchParams({
      action: 'update',
      customer_id: 'ghost',
      name: '顧客',
      primary_industry: 'retail',
    });
    form.append('industries', 'retail');
    await expectAppErrorAsync(
      () => handleAdminCustomersPost(stubPool({ rowCount: 0 }), viewer, form),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('relations: update_type 対象が存在しない(rowCount=0)場合は AIM-6004(400・見つかりません)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminRelationsPost(
          stubPool({ rowCount: 0 }),
          viewer,
          new URLSearchParams({ action: 'update_type', relation_type: 'ghost', label: '種別' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('relations: 既存レコード参照の ID は厳格パターン外でも操作できる(delete_relation)', async () => {
    const location = await handleAdminRelationsPost(
      stubPool(),
      viewer,
      new URLSearchParams({
        action: 'delete_relation',
        from_customer_id: 'Legacy Customer',
        to_customer_id: 'shimamura',
        relation_type: 'supplies_to',
      }),
    );
    expect(location).toContain('saved=deleted');
  });

  it('relations: 新規作成(create_type)の種別IDは厳格パターン検証を維持する', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminRelationsPost(
          stubPool(),
          viewer,
          new URLSearchParams({ action: 'create_type', relation_type: 'Bad Type', label: '種別' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('マスタ管理ページの描画', () => {
  it('全フォームに CSRF hidden input を埋め込む', async () => {
    const out = (
      await renderAdminIndustries(stubPool(), {
        csrfToken: VALID_TOKEN,
        url: new URL('http://localhost/admin/industries'),
      })
    ).html;
    expect(out).toContain(`name="${CSRF_FIELD}" value="${VALID_TOKEN}"`);
  });

  it('保存結果(?saved=)と入力エラーのバナーを表示する', async () => {
    const saved = (
      await renderAdminIndustries(stubPool(), {
        csrfToken: VALID_TOKEN,
        url: new URL('http://localhost/admin/industries?saved=created'),
      })
    ).html;
    expect(saved).toContain('追加しました');

    const errored = (
      await renderAdminIndustries(stubPool(), {
        csrfToken: VALID_TOKEN,
        url: new URL('http://localhost/admin/industries'),
        errorMessage: '<b>入力エラー</b>',
      })
    ).html;
    // エラーメッセージはエスケープして表示する
    expect(errored).toContain('&lt;b&gt;入力エラー&lt;/b&gt;');
    expect(errored).not.toContain('<b>入力エラー</b>');
  });

  it('?saved= に継承プロパティ名(toString 等)を渡しても成功バナーを出さない', async () => {
    const out = (
      await renderAdminIndustries(stubPool(), {
        csrfToken: VALID_TOKEN,
        url: new URL('http://localhost/admin/industries?saved=toString'),
      })
    ).html;
    expect(out).not.toContain('alert ok');
  });
});

describe('adminPostRoute のエラー応答(HTTP 統合)', () => {
  it('413: ボディ過大は AppError のステータスとメッセージで応答する(認証エラーと誤報告しない)', async () => {
    const prevAuthMode = process.env['AUTH_MODE'];
    process.env['AUTH_MODE'] = 'header';
    // 認証(ops.users 照会)には常に admin を返すスタブを使う
    const usersPool = {
      query: () =>
        Promise.resolve({
          rows: [{ user_id: 'u1', display_name: 'テスト', email: 't@example.com', role: 'admin' }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    const server = createDashboardServer(usersPool, stubPool());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/admin/industries',
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-goog-authenticated-user-email': 'accounts.google.com:t@example.com',
            },
          },
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
        req.end('x'.repeat(1024 * 1024 + 1)); // 上限 1MiB 超のボディ
      });
      expect(res.status).toBe(413);
      expect(res.body).toContain('リクエストボディが大きすぎます');
      expect(res.body).not.toContain('認証処理に失敗しました');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevAuthMode === undefined) delete process.env['AUTH_MODE'];
      else process.env['AUTH_MODE'] = prevAuthMode;
    }
  });
});

describe('adminPostRoute の multipart 受信(HTTP 統合・v0.6)', () => {
  it('multipart/form-data の POST でも CSRF 検証と書込ハンドラが動く(PRG 303)', async () => {
    const prevAuthMode = process.env['AUTH_MODE'];
    process.env['AUTH_MODE'] = 'header';
    const usersPool = {
      query: () =>
        Promise.resolve({
          rows: [{ user_id: 'u1', display_name: 'テスト', email: 't@example.com', role: 'admin' }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    const server = createDashboardServer(usersPool, stubPool());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const boundary = 'integration-boundary';
    const fieldPart = (name: string, value: string): string =>
      `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body =
      fieldPart(CSRF_FIELD, VALID_TOKEN) +
      fieldPart('action', 'create') +
      fieldPart('industry_id', 'retail') +
      fieldPart('name', '小売業') +
      `--${boundary}--\r\n`;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/industries`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-goog-authenticated-user-email': 'accounts.google.com:t@example.com',
          cookie: `${CSRF_COOKIE}=${VALID_TOKEN}`,
        },
        body,
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('saved=created');

      // CSRF フィールドがなければ multipart でも 403(検証は同じ経路)
      const noCsrf = await fetch(`http://127.0.0.1:${port}/admin/industries`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-goog-authenticated-user-email': 'accounts.google.com:t@example.com',
          cookie: `${CSRF_COOKIE}=${VALID_TOKEN}`,
        },
        body: fieldPart('action', 'create') + `--${boundary}--\r\n`,
      });
      expect(noCsrf.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevAuthMode === undefined) delete process.env['AUTH_MODE'];
      else process.env['AUTH_MODE'] = prevAuthMode;
    }
  });
});

describe('ナビゲーションの出し分け', () => {
  const body = { html: '<div></div>' };

  it('管理者にはマスタ管理リンクを表示し、/admin 配下でアクティブになる', () => {
    const out = pageLayout({
      title: 't',
      activePath: '/admin/customers',
      viewer,
      body: body as never,
    });
    expect(out).toContain('マスタ管理');
    expect(out).toContain('<a href="/admin/industries" class="active">マスタ管理</a>');
  });

  it('メンバーにはマスタ管理リンクを表示しない', () => {
    const member: Viewer = { ...viewer, role: 'member' };
    const out = pageLayout({ title: 't', activePath: '/', viewer: member, body: body as never });
    expect(out).not.toContain('マスタ管理');
    expect(out).not.toContain('/admin/');
  });
});
