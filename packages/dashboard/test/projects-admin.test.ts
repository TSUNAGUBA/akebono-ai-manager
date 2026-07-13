import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ERROR_CODES, isAppError } from '@ai-manager/shared';
import type { Viewer } from '../src/render/layout.js';
import type { AdminPageContext } from '../src/pages/admin/common.js';
import { handleAdminProjectsPost, renderAdminProjects } from '../src/pages/admin/projects.js';

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/projects${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

const projectRows = [
  {
    project_id: 'a-sha-si',
    name: 'A社SI',
    customer_id: 'a-sha',
    customer_name: 'A社',
    project_type: 'si',
    status: 'active',
    priority: 10,
    admin_owner_id: 'admin1',
    owner_name: '山下',
    updated: '2026-07-13 10:00',
  },
  {
    project_id: 'old-media',
    name: '旧メディア',
    customer_id: null,
    customer_name: null,
    project_type: 'media',
    status: 'closed',
    priority: null,
    admin_owner_id: null,
    owner_name: null,
    updated: '2026-07-01 09:00',
  },
];

/** SQL とパラメータを捕捉するスタブプール(users.test.ts と同旨)。 */
function stubPool(
  captured: CapturedCall[] = [],
  behavior: {
    rowCount?: number;
    rejectWith?: unknown;
    currentStatus?: string;
    currentOwnerId?: string | null;
  } = {},
): pg.Pool {
  const base = {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      // update 前の現在値取得と担当者検証は、書込失敗のシミュレーションの対象外とする
      const isPrecheck =
        text.includes('SELECT status, admin_owner_id FROM ops.projects') ||
        text.includes('FROM ops.users');
      if (behavior.rejectWith !== undefined && !isPrecheck) {
        return Promise.reject(behavior.rejectWith);
      }
      const rows = text.includes('SELECT status, admin_owner_id FROM ops.projects')
        ? [
            {
              status: behavior.currentStatus ?? 'active',
              admin_owner_id: behavior.currentOwnerId ?? 'admin1',
            },
          ]
        : text.includes('FROM ops.projects p')
          ? projectRows
          : text.includes('FROM ops.customers')
            ? [{ customer_id: 'a-sha', name: 'A社' }]
            : text.includes('FROM ops.users')
              ? [{ user_id: 'admin1', display_name: '山下' }]
              : [];
      return Promise.resolve({
        rows,
        rowCount: isPrecheck ? rows.length : (behavior.rowCount ?? rows.length),
      });
    },
  };
  // withTransaction(タスク進捗更新)用: 同じ捕捉クエリを使うクライアントを貸し出す
  return {
    ...base,
    connect: () => Promise.resolve({ query: base.query, release: () => undefined }),
  } as unknown as pg.Pool;
}

function pgError(code: string): Error {
  const err = new Error('constraint violation');
  (err as Error & { code: string }).code = code;
  return err;
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

describe('プロジェクト管理ページの描画', () => {
  it('一覧に顧客名・種別・状態・担当管理者を表示し、追加・編集フォームを備える', async () => {
    const captured: CapturedCall[] = [];
    const out = (await renderAdminProjects(stubPool(captured), adminCtx())).html;

    // 一覧クエリは顧客・担当者を JOIN で名前解決する
    const listQuery = captured[0]?.text ?? '';
    expect(listQuery).toContain('FROM ops.projects p');
    expect(listQuery).toContain('LEFT JOIN ops.customers');
    expect(listQuery).toContain('LEFT JOIN ops.users');
    // 担当管理者の選択肢は active な admin のみ
    const adminsQuery = captured.find((c) => c.text.includes(`role = 'admin'`));
    expect(adminsQuery).toBeDefined();

    expect(out).toContain('A社SI');
    expect(out).toContain('A社');
    expect(out).toContain('SI'); // 種別ラベル
    expect(out).toContain('進行中'); // status=active のバッジ
    expect(out).toContain('終了'); // status=closed のバッジ
    expect(out).toContain('山下');
    // 追加フォーム(project_id は作成時のみ入力可)
    expect(out).toContain('name="project_id"');
    expect(out).toContain('name="project_type"');
    // 全フォームに CSRF hidden input
    expect(out).toContain(`name="_csrf" value="${VALID_TOKEN}"`);
  });

  it('編集モード(?edit=)では対象の値が埋まったフォームを表示する', async () => {
    const out = (await renderAdminProjects(stubPool(), adminCtx('?edit=a-sha-si'))).html;
    expect(out).toContain('プロジェクトの編集: a-sha-si');
    expect(out).toContain('value="A社SI"');
    expect(out).toContain('action" value="update"');
    // 計画情報の任意項目(v0.10)
    expect(out).toContain('name="objective"');
    expect(out).toContain('name="description"');
  });

  it('編集モードではマイルストーンとタスク進捗のセクションを表示する(v0.10)', async () => {
    const captured: CapturedCall[] = [];
    const pool = {
      query: (text: string, params?: unknown[]) => {
        captured.push({ text, params: params ?? [] });
        const rows = text.includes('FROM ops.project_milestones')
          ? [
              { milestone_id: '1', title: '要件確定', due_date: '2026-07-20', status: 'planned' },
              { milestone_id: '2', title: 'キックオフ', due_date: '2026-07-01', status: 'done' },
            ]
          : text.includes('FROM ops.tasks t')
            ? [
                {
                  task_id: '7',
                  title: 'A社の棚卸し',
                  status: 'in_progress',
                  due_date: '2026-07-15',
                  assignee_name: '田中',
                },
              ]
            : text.includes('FROM ops.projects p')
              ? projectRows
              : text.includes('FROM ops.customers')
                ? [{ customer_id: 'a-sha', name: 'A社' }]
                : text.includes('FROM ops.users')
                  ? [{ user_id: 'admin1', display_name: '山下' }]
                  : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    } as unknown as pg.Pool;

    const out = (await renderAdminProjects(pool, adminCtx('?edit=a-sha-si'))).html;

    // マイルストーンはプロジェクト ID で絞って取得する(混同防止)
    const milestoneQuery = captured.find((c) => c.text.includes('FROM ops.project_milestones'));
    expect(milestoneQuery?.params).toEqual(['a-sha-si']);
    const taskQuery = captured.find((c) => c.text.includes('FROM ops.tasks t'));
    expect(taskQuery?.params).toEqual(['a-sha-si']);

    expect(out).toContain('マイルストーン: A社SI');
    expect(out).toContain('要件確定');
    expect(out).toContain('完了にする'); // planned → done のトグル
    expect(out).toContain('未完了に戻す'); // done → planned のトグル
    expect(out).toContain('action" value="add_milestone"');
    expect(out).toContain('タスクと進捗: A社SI');
    expect(out).toContain('A社の棚卸し');
    expect(out).toContain('action" value="update_task_status"');
    // タスクの起票は M3(Chat)が SoT である旨の案内
    expect(out).toContain('Chat のタスク指示');
  });

  it('プロジェクト未登録なら空メッセージを表示する', async () => {
    const pool = {
      query: (text: string) =>
        Promise.resolve({ rows: text.includes('FROM ops.projects p') ? [] : [], rowCount: 0 }),
    } as unknown as pg.Pool;
    const out = (await renderAdminProjects(pool, adminCtx())).html;
    expect(out).toContain('プロジェクトが登録されていません');
  });
});

describe('プロジェクト管理の書込ハンドラ(POST)', () => {
  const createForm = (over: Record<string, string> = {}): URLSearchParams =>
    new URLSearchParams({
      action: 'create',
      project_id: 'b-sha-saas',
      name: 'B社SaaS',
      customer_id: 'a-sha',
      project_type: 'saas',
      status: 'active',
      priority: '20',
      admin_owner_id: 'admin1',
      ...over,
    });

  it('create: 属性を検証して INSERT し、PRG で戻る', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminProjectsPost(stubPool(captured), viewer, createForm());

    const insert = captured.find((c) => c.text.includes('INSERT INTO ops.projects'));
    expect(insert?.params).toEqual([
      'b-sha-saas',
      'B社SaaS',
      'a-sha',
      'saas',
      'active',
      20,
      'admin1',
      null, // objective(任意・未入力)
      null, // description(任意・未入力)
    ]);
    expect(location).toBe('/admin/projects?saved=created#create');
  });

  it('create: 顧客・担当管理者は未指定(空)なら NULL で登録できる', async () => {
    const captured: CapturedCall[] = [];
    await handleAdminProjectsPost(
      stubPool(captured),
      viewer,
      createForm({ customer_id: '', admin_owner_id: '' }),
    );
    const insert = captured.find((c) => c.text.includes('INSERT INTO ops.projects'));
    expect(insert?.params?.[2]).toBeNull();
    expect(insert?.params?.[6]).toBeNull();
  });

  it('create: 種別が CHECK 制約の値集合にない場合は AIM-6004(400)で書き込まない', async () => {
    const captured: CapturedCall[] = [];
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(stubPool(captured), viewer, createForm({ project_type: 'ghost' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '種別',
    );
    expect(captured).toHaveLength(0);
  });

  it('create: 状態が不正な場合は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminProjectsPost(stubPool(), viewer, createForm({ status: 'paused' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '状態',
    );
  });

  it('create: 重複ID(23505)は AIM-6005(409)に変換する', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(stubPool([], { rejectWith: pgError('23505') }), viewer, createForm()),
      ERROR_CODES.ADMIN_WRITE_CONFLICT,
      409,
    );
  });

  it('create: 存在しない顧客/担当者(23503)は AIM-6004(400)に変換する', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(stubPool([], { rejectWith: pgError('23503') }), viewer, createForm()),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });

  it('update: updated_at を更新し、対象が存在しない(rowCount=0)場合は AIM-6004(400)', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminProjectsPost(
      stubPool(captured, { rowCount: 1 }),
      viewer,
      createForm({ action: 'update', project_id: 'a-sha-si', status: 'closed' }),
    );
    const update = captured.find((c) => c.text.includes('UPDATE ops.projects'));
    expect(update?.text).toContain('updated_at = now()');
    expect(update?.params?.[4]).toBe('closed');
    expect(location).toBe('/admin/projects?saved=updated');

    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(
          stubPool([], { rowCount: 0 }),
          viewer,
          createForm({ action: 'update', project_id: 'ghost', admin_owner_id: '' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('update: リスト外の既存 status は「現在値の温存」として許可される(原則7)', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminProjectsPost(
      stubPool(captured, { rowCount: 1, currentStatus: 'legacy' }),
      viewer,
      createForm({ action: 'update', project_id: 'a-sha-si', status: 'legacy' }),
    );
    const update = captured.find((c) => c.text.includes('UPDATE ops.projects'));
    expect(update?.params?.[4]).toBe('legacy'); // 黙って active に巻き戻さない
    expect(location).toBe('/admin/projects?saved=updated');

    // 現在値でもリスト値でもない status は従来どおり 400
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(
          stubPool([], { currentStatus: 'legacy' }),
          viewer,
          createForm({ action: 'update', project_id: 'a-sha-si', status: 'paused' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '状態',
    );
  });

  it('update: 降格済みの現担当者は温存できる(変更せず送信してもブロックしない)', async () => {
    const captured: CapturedCall[] = [];
    // 現担当 retired-admin は role=member に降格済み(admin 検索では見つからない)想定。
    // 現在値と同じ担当者の指定はロール検証をスキップして温存される
    const location = await handleAdminProjectsPost(
      stubPool(captured, { rowCount: 1, currentOwnerId: 'retired-admin' }),
      viewer,
      createForm({ action: 'update', project_id: 'a-sha-si', admin_owner_id: 'retired-admin' }),
    );
    // ロール検証クエリ(FROM ops.users)は発行されない
    expect(captured.find((c) => c.text.includes('FROM ops.users'))).toBeUndefined();
    const update = captured.find((c) => c.text.includes('UPDATE ops.projects'));
    expect(update?.params?.[6]).toBe('retired-admin'); // 黙って NULL 化も拒否もしない
    expect(location).toBe('/admin/projects?saved=updated');
  });

  it('担当管理者が admin ロールでない場合は AIM-6004(400)で書き込まない(フォーム偽装防御)', async () => {
    const captured: CapturedCall[] = [];
    const pool = {
      query: (text: string, params?: unknown[]) => {
        captured.push({ text, params: params ?? [] });
        // admin ロール検証クエリが 0 行 = member や未知ユーザーの指定
        if (text.includes('FROM ops.users')) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as pg.Pool;
    await expectAppErrorAsync(
      () => handleAdminProjectsPost(pool, viewer, createForm({ admin_owner_id: 'member1' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'admin ロール',
    );
    expect(captured.find((c) => c.text.includes('INSERT INTO ops.projects'))).toBeUndefined();
  });

  it('編集フォームはリスト外の現在値(status・現担当)を選択肢に残す(黙った書き換え防止)', async () => {
    const legacyRows = [
      {
        ...projectRows[0],
        status: 'on_hold',
        admin_owner_id: 'retired-admin',
        owner_name: '退任管理者',
      },
    ];
    const pool = {
      query: (text: string) =>
        Promise.resolve({
          rows: text.includes('FROM ops.projects p')
            ? legacyRows
            : text.includes('FROM ops.customers')
              ? [{ customer_id: 'a-sha', name: 'A社' }]
              : text.includes('FROM ops.users')
                ? [{ user_id: 'admin1', display_name: '山下' }]
                : [],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;

    const out = (await renderAdminProjects(pool, adminCtx('?edit=a-sha-si'))).html;
    expect(out).toContain('on_hold(現在値)');
    expect(out).toContain('退任管理者(現担当)');
  });

  it('不明な action は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminProjectsPost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('マイルストーン管理(POST・v0.10)', () => {
  it('add_milestone: プロジェクトに紐づけて INSERT し、編集画面へ PRG で戻る', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminProjectsPost(
      stubPool(captured),
      viewer,
      new URLSearchParams({
        action: 'add_milestone',
        project_id: 'a-sha-si',
        title: '要件確定',
        due_date: '2026-07-20',
      }),
    );
    const insert = captured.find((c) => c.text.includes('INSERT INTO ops.project_milestones'));
    expect(insert?.params).toEqual(['a-sha-si', '要件確定', '2026-07-20']);
    expect(location).toBe('/admin/projects?edit=a-sha-si&saved=created#milestones');
  });

  it('add_milestone: 期日は任意(空なら NULL)。不正な日付形式は AIM-6004(400)', async () => {
    const captured: CapturedCall[] = [];
    await handleAdminProjectsPost(
      stubPool(captured),
      viewer,
      new URLSearchParams({ action: 'add_milestone', project_id: 'a-sha-si', title: 'β公開' }),
    );
    const insert = captured.find((c) => c.text.includes('INSERT INTO ops.project_milestones'));
    expect(insert?.params?.[2]).toBeNull();

    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(
          stubPool(),
          viewer,
          new URLSearchParams({
            action: 'add_milestone',
            project_id: 'a-sha-si',
            title: 'β公開',
            due_date: '7月20日',
          }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'YYYY-MM-DD',
    );
  });

  it('toggle_milestone / delete_milestone: project_id を条件に含め、他プロジェクトの操作を拒否する(混同防止)', async () => {
    const captured: CapturedCall[] = [];
    await handleAdminProjectsPost(
      stubPool(captured, { rowCount: 1 }),
      viewer,
      new URLSearchParams({
        action: 'toggle_milestone',
        project_id: 'a-sha-si',
        milestone_id: '1',
        status: 'done',
      }),
    );
    const update = captured.find((c) => c.text.includes('UPDATE ops.project_milestones'));
    expect(update?.text).toContain('milestone_id = $1 AND project_id = $2');
    expect(update?.params).toEqual(['1', 'a-sha-si', 'done']);

    // 他プロジェクトのマイルストーン(WHERE 不一致 → rowCount=0)は 400
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(
          stubPool([], { rowCount: 0 }),
          viewer,
          new URLSearchParams({
            action: 'delete_milestone',
            project_id: 'another-project',
            milestone_id: '1',
          }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
  });

  it('toggle_milestone: 状態は planned/done のみ許可する', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminProjectsPost(
          stubPool(),
          viewer,
          new URLSearchParams({
            action: 'toggle_milestone',
            project_id: 'a-sha-si',
            milestone_id: '1',
            status: 'cancelled',
          }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('タスク進捗の更新(POST・v0.10)', () => {
  function taskPool(
    captured: CapturedCall[],
    behavior: { currentTaskStatus?: string; taskFound?: boolean } = {},
  ): pg.Pool {
    const run = (text: string, params?: unknown[]): Promise<unknown> => {
      captured.push({ text, params: params ?? [] });
      const rows = text.includes('SELECT status FROM ops.tasks')
        ? behavior.taskFound === false
          ? []
          : [{ status: behavior.currentTaskStatus ?? 'in_progress' }]
        : [];
      return Promise.resolve({ rows, rowCount: rows.length === 0 ? 1 : rows.length });
    };
    return {
      query: run,
      connect: () => Promise.resolve({ query: run, release: () => undefined }),
    } as unknown as pg.Pool;
  }

  const statusForm = (over: Record<string, string> = {}): URLSearchParams =>
    new URLSearchParams({
      action: 'update_task_status',
      project_id: 'a-sha-si',
      task_id: '7',
      status: 'done',
      ...over,
    });

  it('状態を更新し、遷移を task_status_log(changed_via=admin)へ同一トランザクションで記録する', async () => {
    const captured: CapturedCall[] = [];
    const location = await handleAdminProjectsPost(taskPool(captured), viewer, statusForm());

    // project_id を条件に含めて対象タスクをロックする(混同防止)
    const select = captured.find((c) => c.text.includes('SELECT status FROM ops.tasks'));
    expect(select?.text).toContain('task_id = $1 AND project_id = $2');
    expect(select?.text).toContain('FOR UPDATE');
    expect(select?.params).toEqual(['7', 'a-sha-si']);

    const update = captured.find((c) => c.text.includes('UPDATE ops.tasks'));
    expect(update?.params).toEqual(['7', 'done']);
    expect(update?.text).toContain(`CASE WHEN $2 = 'done' THEN now() ELSE NULL END`);

    const log = captured.find((c) => c.text.includes('INSERT INTO ops.task_status_log'));
    expect(log?.params).toEqual(['7', 'in_progress', 'done']);
    expect(log?.text).toContain(`'admin'`);

    // BEGIN → SELECT → UPDATE → INSERT → COMMIT の順(SoT 書込と履歴が同一トランザクション)
    const beginIdx = captured.findIndex((c) => c.text === 'BEGIN');
    const commitIdx = captured.findIndex((c) => c.text === 'COMMIT');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(captured.findIndex((c) => c.text.includes('task_status_log')));

    expect(location).toBe('/admin/projects?edit=a-sha-si&saved=updated#tasks');
  });

  it('同一状態への更新は no-op(履歴を汚さない・冪等)', async () => {
    const captured: CapturedCall[] = [];
    await handleAdminProjectsPost(
      taskPool(captured, { currentTaskStatus: 'done' }),
      viewer,
      statusForm(),
    );
    expect(captured.find((c) => c.text.includes('UPDATE ops.tasks'))).toBeUndefined();
    expect(captured.find((c) => c.text.includes('task_status_log'))).toBeUndefined();
  });

  it('別プロジェクトのタスク(不一致)は AIM-6004(400)で更新しない', async () => {
    const captured: CapturedCall[] = [];
    await expectAppErrorAsync(
      () => handleAdminProjectsPost(taskPool(captured, { taskFound: false }), viewer, statusForm()),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '見つかりません',
    );
    expect(captured.find((c) => c.text.includes('UPDATE ops.tasks'))).toBeUndefined();
  });

  it('不正な状態値は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminProjectsPost(taskPool([]), viewer, statusForm({ status: 'paused' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});
