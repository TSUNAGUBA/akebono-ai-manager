import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ERROR_CODES, isAppError } from '@ai-manager/shared';
import type { Viewer } from '../src/render/layout.js';
import type { AdminPageContext } from '../src/pages/admin/common.js';
import { handleAdminUsersPost, renderAdminUsers } from '../src/pages/admin/users.js';

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/users${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

const userRows = [
  {
    user_id: 'admin1',
    display_name: '山下',
    role: 'admin',
    active: true,
    dm_ready: true,
    checkin_enabled: false,
  },
  {
    user_id: 'member1',
    display_name: '田中',
    role: 'member',
    active: true,
    dm_ready: false,
    checkin_enabled: true,
  },
];

/** SQL とパラメータを捕捉するスタブプール(checkin.test.ts と同旨)。 */
function stubPool(
  captured: CapturedCall[] = [],
  behavior: { rows?: unknown[]; rowCount?: number } = {},
): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      const rows = text.includes('FROM ops.users') ? (behavior.rows ?? userRows) : [];
      return Promise.resolve({ rows, rowCount: behavior.rowCount ?? rows.length });
    },
  } as unknown as pg.Pool;
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
      if (messageContains !== undefined) expect(err.message).toContain(messageContains);
    }
    return;
  }
  expect.fail('例外が発生しませんでした');
}

describe('ユーザー設定ページの描画', () => {
  it('全ユーザーをロール・状態・問いかけ可否付きで一覧し、列単位 GRANT の範囲だけを参照する', async () => {
    const captured: CapturedCall[] = [];
    const out = (await renderAdminUsers(stubPool(captured), adminCtx())).html;

    // 参照列は admin_rw の列単位 GRANT の範囲に収める(email には触れない)
    const listQuery = captured[0]?.text ?? '';
    expect(listQuery).toContain('FROM ops.users');
    expect(listQuery).not.toContain('email');
    // ロールで絞らず全ユーザーを表示する(問いかけ可否はロールから独立 — v0.8)
    expect(listQuery).not.toContain(`role = 'member'`);

    expect(out).toContain('山下');
    expect(out).toContain('管理者');
    expect(out).toContain('田中');
    expect(out).toContain('メンバー');
    expect(out).toContain('問いかけ可');
    expect(out).toContain('問いかけ不可');
    // トグルは目標値を明示した hidden input で送る(盲目的フリップではない)
    expect(out).toContain('name="enabled" value="1"'); // 不可の山下 → 再開(1)
    expect(out).toContain('name="enabled" value="0"'); // 可の田中 → 停止(0)
    expect(out).toContain('問いかけを再開する');
    expect(out).toContain('問いかけを止める');
    // 全フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
    // サブナビにユーザータブ
    expect(out).toContain('/admin/users');
  });

  it('ユーザー未登録なら空メッセージを表示する', async () => {
    const out = (await renderAdminUsers(stubPool([], { rows: [] }), adminCtx())).html;
    expect(out).toContain('ユーザーが登録されていません');
  });
});

describe('ユーザー設定の書込ハンドラ(POST)', () => {
  it('toggle_checkin: checkin_enabled のみを目標値で更新し PRG で戻る', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminUsersPost(
      stubPool(captured, { rowCount: 1 }),
      viewer,
      new URLSearchParams({ action: 'toggle_checkin', user_id: 'member1', enabled: '0' }),
    );

    const update = captured[0];
    expect(update?.text).toContain('UPDATE ops.users SET checkin_enabled = $2');
    // checkin_enabled 以外の列に触れない(列単位 GRANT と同じ境界)
    expect(update?.text).not.toContain('role');
    expect(update?.text).not.toContain('display_name');
    expect(update?.params).toEqual(['member1', false]);
    expect(location).toBe('/admin/users?saved=updated');
  });

  it('toggle_checkin: 対象が見つからない(rowCount=0)場合は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminUsersPost(
          stubPool([], { rowCount: 0 }),
          viewer,
          new URLSearchParams({ action: 'toggle_checkin', user_id: 'ghost', enabled: '1' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('toggle_checkin: enabled が 0/1 以外は AIM-6004(400)で更新しない', async () => {
    const captured: CapturedCall[] = [];
    await expectAppErrorAsync(
      () =>
        handleAdminUsersPost(
          stubPool(captured),
          viewer,
          new URLSearchParams({ action: 'toggle_checkin', user_id: 'member1', enabled: 'true' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
    expect(captured).toHaveLength(0);
  });

  it('user_id 未指定は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminUsersPost(
          stubPool(),
          viewer,
          new URLSearchParams({ action: 'toggle_checkin', enabled: '1' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminUsersPost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});
