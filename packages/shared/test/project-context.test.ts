import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { fetchProjectContextById, fetchProjectContextForUser } from '../src/project-context.js';

interface CapturedCall {
  text: string;
  params: unknown[];
}

function stubPool(
  responder: (text: string, params: unknown[]) => { rows: unknown[] } | Error,
  captured: CapturedCall[] = [],
): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      const result = responder(text, params ?? []);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ rows: result.rows, rowCount: result.rows.length });
    },
  } as unknown as pg.Pool;
}

const project = {
  project_id: 'a-sha-si',
  name: 'A社SI',
  customer_name: 'A社',
  objective: '基幹システムの刷新',
  description: null,
};

describe('fetchProjectContextById(プロジェクト計画情報の整形)', () => {
  it('目的・マイルストーンを整形し、未入力の任意項目(内容)は出力しない', async () => {
    const block = await fetchProjectContextById(
      stubPool((text) => {
        if (text.includes('FROM ops.projects p')) return { rows: [project] };
        if (text.includes('FROM ops.project_milestones')) {
          return {
            rows: [
              { project_id: 'a-sha-si', title: 'キックオフ', due_date: '2026-07-01', status: 'done' },
              { project_id: 'a-sha-si', title: '要件確定', due_date: '2026-07-20', status: 'planned' },
            ],
          };
        }
        return { rows: [] };
      }),
      'a-sha-si',
    );

    expect(block).toContain('### プロジェクト: A社SI(顧客: A社)');
    expect(block).toContain('- 目的: 基幹システムの刷新');
    expect(block).not.toContain('- 内容:'); // 未入力の任意項目は省略(v0.10 §2)
    expect(block).toContain('[済] キックオフ(期日: 2026-07-01)');
    expect(block).toContain('[予定] 要件確定(期日: 2026-07-20)');
  });

  it('顧客未設定・計画情報なしのプロジェクトは名称のみのブロックになる', async () => {
    const block = await fetchProjectContextById(
      stubPool((text) => {
        if (text.includes('FROM ops.projects p')) {
          return {
            rows: [{ ...project, customer_name: null, objective: null, description: null }],
          };
        }
        return { rows: [] };
      }),
      'a-sha-si',
    );
    expect(block).toBe('### プロジェクト: A社SI');
  });

  it('プロジェクトが見つからなければ undefined', async () => {
    await expect(
      fetchProjectContextById(
        stubPool(() => ({ rows: [] })),
        'ghost',
      ),
    ).resolves.toBeUndefined();
  });

  it('取得失敗は undefined(非ブロッキング — 呼び出し元は文脈なしで継続)', async () => {
    await expect(
      fetchProjectContextById(
        stubPool(() => new Error('db down')),
        'a-sha-si',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('fetchProjectContextForUser(本人のタスクが属するプロジェクトの文脈)', () => {
  it('未完了タスクの属する active プロジェクトを優先度順・上限付きで対象にする', async () => {
    const captured: CapturedCall[] = [];
    const block = await fetchProjectContextForUser(
      stubPool((text) => {
        if (text.includes('FROM ops.tasks t')) {
          return { rows: [{ project_id: 'a-sha-si' }] };
        }
        if (text.includes('FROM ops.projects p')) return { rows: [project] };
        return { rows: [] };
      }, captured),
      'member1',
    );

    const contextQuery = captured.find((c) => c.text.includes('FROM ops.tasks t'));
    expect(contextQuery?.params).toEqual(['member1']);
    // 未完了(approved / in_progress / blocked)のみが文脈対象
    expect(contextQuery?.text).toContain(`'approved', 'in_progress', 'blocked'`);
    // 終了プロジェクトは供給しない+件数上限(プロンプト肥大の防止 — v0.10 §4.1)
    expect(contextQuery?.text).toContain(`p.status = 'active'`);
    expect(contextQuery?.text).toContain('LIMIT 5');
    expect(contextQuery?.text).toContain('ORDER BY p.priority NULLS LAST');
    expect(block).toContain('A社SI');
  });

  it('プロジェクトに属するタスクがなければ undefined(ブロック自体を出さない)', async () => {
    await expect(
      fetchProjectContextForUser(
        stubPool(() => ({ rows: [] })),
        'member1',
      ),
    ).resolves.toBeUndefined();
  });

  it('取得失敗は undefined(非ブロッキング)', async () => {
    await expect(
      fetchProjectContextForUser(
        stubPool(() => new Error('db down')),
        'member1',
      ),
    ).resolves.toBeUndefined();
  });
});
