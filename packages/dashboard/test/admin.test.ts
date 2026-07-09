import { describe, expect, it } from 'vitest';
import type http from 'node:http';
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
  ID_PATTERN,
  isChecked,
  isUniqueViolation,
  optionalInt,
  optionalText,
  requireId,
  requireText,
} from '../src/admin/form.js';
import { renderAdminIndustries } from '../src/pages/admin/industries.js';
import { handleAdminCustomersPost } from '../src/pages/admin/customers.js';
import { handleAdminIndustriesPost } from '../src/pages/admin/industries.js';
import { handleAdminRelationsPost } from '../src/pages/admin/relations.js';
import { pageLayout, type Viewer } from '../src/render/layout.js';

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
): Promise<void> {
  try {
    await fn();
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
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    const req = { headers: cookie === undefined ? {} : { cookie } } as http.IncomingMessage;
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as http.ServerResponse;
    return { req, res, headers };
  }

  it('ensureCsrfToken: クッキーがなければ新規発行して Set-Cookie する', () => {
    const { req, res, headers } = mockReqRes();
    const token = ensureCsrfToken(req, res);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const setCookie = headers['set-cookie'];
    expect(setCookie).toContain(`${CSRF_COOKIE}=${token}`);
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/admin');
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
    expect(headers['set-cookie']).toContain(`${CSRF_COOKIE}=${token}`);
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

/** 何を投げるかを差し替えられるスタブプール。 */
function stubPool(behavior?: { rejectWith?: unknown }): pg.Pool {
  const query = () =>
    behavior?.rejectWith !== undefined
      ? Promise.reject(behavior.rejectWith)
      : Promise.resolve({ rows: [], rowCount: 1 });
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
    expect(isUniqueViolation(pgError('23505'))).toBe(false); // 生の pg エラーは対象外(query() が包んだ AppError の cause を見る)
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
