import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeSync } from '../src/jobs/knowledge-sync.js';
import { createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  listFilesRecursive: vi.fn(),
  embedTexts: vi.fn(),
  fetchFileText: vi.fn(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, listFilesRecursive: mocks.listFilesRecursive, embedTexts: mocks.embedTexts };
});

vi.mock('../src/drive.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/drive.js')>();
  return { ...mod, fetchFileText: mocks.fetchFileText };
});

const docFile = { id: 'doc-1', name: 'profile.md', mimeType: 'text/markdown', path: 'customer/acme' };

/** マスタ空・既存チャンクなしの既定 responder。 */
const baseResponder: Responder = () => ({ rows: [] });

let savedFolderId: string | undefined;

beforeEach(() => {
  savedFolderId = process.env['KNOWLEDGE_DRIVE_FOLDER_ID'];
  process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
  mocks.listFilesRecursive.mockReset().mockResolvedValue({ files: [docFile], unresolvedShortcuts: [] });
  mocks.embedTexts.mockReset().mockResolvedValue([[0.1, 0.2, 0.3]]);
  mocks.fetchFileText.mockReset().mockResolvedValue('# プロフィール本文');
});

afterEach(() => {
  if (savedFolderId === undefined) delete process.env['KNOWLEDGE_DRIVE_FOLDER_ID'];
  else process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = savedFolderId;
});

describe('runKnowledgeSync(ナレッジ同期の掃除保護 — v0.11)', () => {
  it('通常フロー: チャンクを UPSERT し、削除済み文書の掃除(doc_id = ANY)を実行する', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runKnowledgeSync(pool);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeDefined();
    const cleanup = findCall(calls, 'doc_id = ANY');
    expect(cleanup).toBeDefined();
    expect(cleanup?.params[0]).toEqual(['doc-1']);
  });

  it('掃除は Drive 由来でない還流チャンク(escalation/% と feedback/%)を除外する(v0.12 §7)', async () => {
    const { pool, calls } = createMockPool(baseResponder);
    await runKnowledgeSync(pool);

    const cleanup = findCall(calls, 'doc_id = ANY');
    // SoT が ops.escalations / ops.dialogue_feedback にあるキャッシュを Drive 同期が消さない
    expect(cleanup?.text).toContain(`doc_id NOT LIKE 'escalation/%'`);
    expect(cleanup?.text).toContain(`doc_id NOT LIKE 'feedback/%'`);
  });

  it('アクセスできないショートカットがある場合、削除掃除をスキップして既存チャンクを保護する(原則2)', async () => {
    mocks.listFilesRecursive.mockResolvedValue({
      files: [docFile],
      unresolvedShortcuts: [{ name: 'shimamura', path: 'customer' }],
    });
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runKnowledgeSync(pool);

    // 同期自体は継続する(見えているファイルは取り込む)
    expect(summary.sent).toBe(1);
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeDefined();
    // 見えないショートカット配下を「削除された」と誤判定しない
    expect(findCall(calls, 'doc_id = ANY')).toBeUndefined();
  });

  it('ファイルが 0 件の場合は掃除を実行しない(全消し事故の防止)', async () => {
    mocks.listFilesRecursive.mockResolvedValue({ files: [], unresolvedShortcuts: [] });
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runKnowledgeSync(pool);

    expect(summary).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(findCall(calls, 'doc_id = ANY')).toBeUndefined();
  });

  it('テキストを取得できないファイル(対応外形式・テキスト層なし PDF)はスキップに数える', async () => {
    mocks.fetchFileText.mockResolvedValue(undefined);
    const { pool, calls } = createMockPool(baseResponder);
    const summary = await runKnowledgeSync(pool);

    expect(summary).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeUndefined();
    // スキップしたファイルも列挙済みのため、掃除の保護対象に含まれる(チャンクは消えない)
    expect(findCall(calls, 'doc_id = ANY')?.params[0]).toEqual(['doc-1']);
  });
});

describe('runKnowledgeSync(プロジェクトナレッジ — v0.12 §4)', () => {
  const projectFile = { id: 'doc-p', name: 'plan.md', mimeType: 'text/markdown', path: 'project/p1' };

  it('project/{プロジェクトID}/ の文書を project_doc として project_id 付きで取り込む', async () => {
    mocks.listFilesRecursive.mockResolvedValue({ files: [projectFile], unresolvedShortcuts: [] });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.projects')) return { rows: [{ project_id: 'p1' }] };
      return { rows: [] };
    });
    const summary = await runKnowledgeSync(pool);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const insert = findCall(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(insert?.text).toContain('project_id');
    // params: [doc_id, doc_type, customer_id, industry_id, project_id, title, ...]
    expect(insert?.params[1]).toBe('project_doc');
    expect(insert?.params[4]).toBe('p1');
    // 本文が変わらない場合の分類追従(UPDATE)にも project_id が含まれる
    const follow = findCall(calls, 'project_id IS DISTINCT FROM');
    expect(follow?.params).toEqual(['doc-p', 'project_doc', null, null, 'p1']);
  });

  it('プロジェクトIDがマスタに無くても project_id を保持して取り込みを継続する(顧客IDと同じ扱い)', async () => {
    mocks.listFilesRecursive.mockResolvedValue({ files: [projectFile], unresolvedShortcuts: [] });
    const { pool, calls } = createMockPool(baseResponder); // ops.projects は空
    const summary = await runKnowledgeSync(pool);

    expect(summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    // 業界(industry_id は NULL 化)と異なり、後からのマスタ登録で有効になるよう保持する
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')?.params[4]).toBe('p1');
  });
});
