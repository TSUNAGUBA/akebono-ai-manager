import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { AppError, ERROR_CODES, isAppError, type DriveFile, type MultipartFile } from '@ai-manager/shared';
import type { Viewer } from '../src/render/layout.js';
import type { AdminPageContext } from '../src/pages/admin/common.js';

const mocks = vi.hoisted(() => ({
  listFilesRecursive: vi.fn<(rootFolderId: string) => Promise<DriveFile[]>>(),
  ensureSubfolder: vi.fn<(parentId: string, ...segments: string[]) => Promise<string>>(),
  upsertTextFile:
    vi.fn<(folderId: string, fileName: string, content: string) => Promise<{ fileId: string; action: 'created' | 'updated' }>>(),
  trashFile: vi.fn<(fileId: string) => Promise<void>>(),
  getIdTokenFor: vi.fn<(audience: string) => Promise<string>>(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, ...mocks };
});

// vi.mock 適用後に読み込む(モック済みの shared を参照させる)
const { handleAdminKnowledgePost, knowledgeFolderSegments, normalizeKnowledgeFileName, renderAdminKnowledge } =
  await import('../src/pages/admin/knowledge.js');

const viewer: Viewer = { userId: 'u1', displayName: 'テスト', email: 't@example.com', role: 'admin' };
const VALID_TOKEN = 'a'.repeat(64);

const adminCtx = (query = ''): AdminPageContext => ({
  csrfToken: VALID_TOKEN,
  url: new URL(`http://localhost/admin/knowledge${query}`),
});

interface CapturedCall {
  text: string;
  params: unknown[];
}

/** SQL とパラメータを捕捉するスタブプール(pages-query-params.test.ts と同旨)。 */
function stubPool(captured: CapturedCall[] = [], behavior?: { rowCount?: number }): pg.Pool {
  return {
    query: (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return Promise.resolve({ rows: [], rowCount: behavior?.rowCount ?? 1 });
    },
  } as unknown as pg.Pool;
}

function maxPlaceholder(sql: string): number {
  const matches = sql.match(/\$(\d+)/g) ?? [];
  return matches.reduce((max, m) => Math.max(max, Number(m.slice(1))), 0);
}

function assertCallsValid(captured: CapturedCall[]): void {
  expect(captured.length).toBeGreaterThan(0);
  for (const call of captured) {
    const expected = maxPlaceholder(call.text);
    expect(
      call.params.length,
      `プレースホルダ $${expected} 個に対しパラメータ ${call.params.length} 個: ${call.text.slice(0, 80)}`,
    ).toBe(expected);
  }
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

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ['KNOWLEDGE_DRIVE_FOLDER_ID', 'BATCH_URL']) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  mocks.listFilesRecursive.mockReset().mockResolvedValue([
    {
      id: 'doc-1',
      name: 'profile.md',
      mimeType: 'text/markdown',
      path: 'customer/acme',
      // UTC 16:00 = JST 翌 01:00(タイムゾーン変換の確認用)
      modifiedTime: '2026-07-08T16:00:00.000Z',
    },
    { id: 'doc-2', name: 'ルール.md', mimeType: 'text/markdown', path: 'judgement' },
  ]);
  mocks.ensureSubfolder.mockReset().mockResolvedValue('target-folder');
  mocks.upsertTextFile.mockReset().mockResolvedValue({ fileId: 'file-new', action: 'created' });
  mocks.trashFile.mockReset().mockResolvedValue(undefined);
  mocks.getIdTokenFor.mockReset().mockResolvedValue('id-token');
});

afterEach(() => {
  for (const name of ['KNOWLEDGE_DRIVE_FOLDER_ID', 'BATCH_URL']) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.unstubAllGlobals();
});

describe('ファイル名の検証(normalizeKnowledgeFileName)', () => {
  it('拡張子がなければ .md を付与する', () => {
    expect(normalizeKnowledgeFileName('operations')).toBe('operations.md');
    expect(normalizeKnowledgeFileName('  notes  ')).toBe('notes.md');
  });

  it('.md / .txt はそのまま受け入れる', () => {
    expect(normalizeKnowledgeFileName('decision-rules.md')).toBe('decision-rules.md');
    expect(normalizeKnowledgeFileName('memo_01.txt')).toBe('memo_01.txt');
  });

  it('規約外(大文字・日本語・空白・スラッシュ・空)は AIM-6004(400)', () => {
    for (const bad of ['Readme.md', 'メモ.md', 'a b.md', 'a/b.md', "it's.md", '']) {
      expect(() => normalizeKnowledgeFileName(bad)).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.ADMIN_INPUT_INVALID, status: 400 }),
      );
    }
  });

  it('128 文字超は AIM-6004(400)', () => {
    expect(() => normalizeKnowledgeFileName(`${'a'.repeat(129)}.md`)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.ADMIN_INPUT_INVALID }),
    );
  });
});

describe('格納先パスの組み立て(knowledgeFolderSegments)', () => {
  it('judgement / domain / customer をフォルダ規約(M1)のセグメントに変換する', () => {
    expect(knowledgeFolderSegments('judgement', null, null)).toEqual(['judgement']);
    expect(knowledgeFolderSegments('domain', 'retail', null)).toEqual(['domain', 'retail']);
    expect(knowledgeFolderSegments('customer', null, 'acme')).toEqual(['customer', 'acme']);
  });

  it('業界・顧客の未選択、不明な格納先は AIM-6004(400)', () => {
    for (const call of [
      () => knowledgeFolderSegments('domain', null, null),
      () => knowledgeFolderSegments('customer', null, null),
      () => knowledgeFolderSegments('root', null, null),
    ]) {
      expect(call).toThrowError(expect.objectContaining({ code: ERROR_CODES.ADMIN_INPUT_INVALID }));
    }
  });
});

describe('ナレッジページの描画', () => {
  it('KNOWLEDGE_DRIVE_FOLDER_ID 未設定なら案内表示(Drive には触れない)', async () => {
    const out = (await renderAdminKnowledge(stubPool(), adminCtx())).html;
    expect(out).toContain('ナレッジ管理は未構成です');
    expect(out).toContain('KNOWLEDGE_DRIVE_FOLDER_ID');
    expect(mocks.listFilesRecursive).not.toHaveBeenCalled();
  });

  it('一覧と同期状態を表示し、全クエリでプレースホルダ数とパラメータ数が一致する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const captured: CapturedCall[] = [];
    const out = (await renderAdminKnowledge(stubPool(captured), adminCtx())).html;
    assertCallsValid(captured);
    expect(mocks.listFilesRecursive).toHaveBeenCalledWith('root-folder');
    expect(out).toContain('profile.md');
    expect(out).toContain('customer/acme');
    // Drive の更新日時は JST で表示(modifiedTime なしは —)
    expect(out).toContain('2026-07-09 01:00');
    // チャンクなし(スタブは空行)のため未同期表示
    expect(out).toContain('未同期');
    // 全フォーム(投入・削除)に CSRF hidden input
    expect(out).toContain(`value="${VALID_TOKEN}"`);
    // サブナビにナレッジタブ
    expect(out).toContain('/admin/knowledge');
  });

  it('BATCH_URL 未設定なら同期ボタンを出さず自動同期の案内を表示する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const out = (await renderAdminKnowledge(stubPool(), adminCtx())).html;
    expect(out).not.toContain('>今すぐ同期</button>');
    expect(out).toContain('毎日 06:30');
  });

  it('BATCH_URL 設定時は「今すぐ同期」ボタンを表示する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const out = (await renderAdminKnowledge(stubPool(), adminCtx())).html;
    expect(out).toContain('>今すぐ同期</button>');
  });

  it('Drive 一覧の取得失敗は 500 にせずページ内のエラー表示に留める(原則4)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    mocks.listFilesRecursive.mockRejectedValue(new Error('drive down'));
    const out = (await renderAdminKnowledge(stubPool(), adminCtx())).html;
    expect(out).toContain('一覧を取得できませんでした');
    expect(out).toContain('Step 7-3');
  });

  it('同期結果のフラッシュ(?synced=)を表示し、数値以外は 0 に丸める', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const out = (
      await renderAdminKnowledge(stubPool(), adminCtx('?synced=1&sent=3&skipped=2&failed=<x>'))
    ).html;
    expect(out).toContain('同期が完了しました');
    expect(out).toContain('更新 3 件');
    expect(out).not.toContain('<x>');
  });

  it('アップロード結果のフラッシュ(?uploaded=1)は件数と規約適合の失敗ファイル名のみ表示する(受け入れ基準1)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const failedNames = encodeURIComponent('b.md,<img>.md,大文字.txt');
    const out = (
      await renderAdminKnowledge(
        stubPool(),
        adminCtx(`?uploaded=1&created=2&updated=1&failed=2&failed_names=${failedNames}`),
      )
    ).html;
    expect(out).toContain('新規 2 件・上書き 1 件・失敗 2 件');
    // 失敗ファイル名はファイル名規約に一致するもののみ表示(クエリ偽装による表示注入の防止)
    expect(out).toContain('失敗したファイル: b.md');
    expect(out).not.toContain('<img>');
    expect(out).not.toContain('大文字');
  });

  it('アップロードフォーム(ファイル・複数)と直接入力フォームの両方を表示する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const out = (await renderAdminKnowledge(stubPool(), adminCtx())).html;
    expect(out).toContain('enctype="multipart/form-data"');
    expect(out).toContain('name="files" multiple');
    expect(out).toContain('value="upload_files"');
    expect(out).toContain('value="upload"');
    expect(out).toContain('<textarea name="content"');
  });
});

describe('ナレッジ書込ハンドラ(POST)', () => {
  const uploadForm = (fields: Record<string, string>): URLSearchParams =>
    new URLSearchParams({ action: 'upload', ...fields });

  it('KNOWLEDGE_DRIVE_FOLDER_ID 未設定なら AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, uploadForm({ target: 'judgement' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'KNOWLEDGE_DRIVE_FOLDER_ID',
    );
  });

  it('upload: 共通(judgement)への投入は ensureSubfolder + upsertTextFile を呼ぶ', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const captured: CapturedCall[] = [];
    const location = await handleAdminKnowledgePost(
      stubPool(captured),
      viewer,
      uploadForm({ target: 'judgement', file_name: 'decision-rules', content: '# 判断基準' }),
    );
    expect(location).toBe('/admin/knowledge?saved=created');
    expect(mocks.ensureSubfolder).toHaveBeenCalledWith('root-folder', 'judgement');
    expect(mocks.upsertTextFile).toHaveBeenCalledWith('target-folder', 'decision-rules.md', '# 判断基準');
  });

  it('upload: 業界への投入は domain/{業界ID} 配下で、実在検証の SQL パラメータが整合する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const captured: CapturedCall[] = [];
    const location = await handleAdminKnowledgePost(
      stubPool(captured),
      viewer,
      uploadForm({ target: 'domain', industry_id: 'retail', file_name: 'operations.md', content: '本文' }),
    );
    assertCallsValid(captured);
    expect(captured[0]?.text).toContain('ops.industries');
    expect(location).toBe('/admin/knowledge?saved=created');
    expect(mocks.ensureSubfolder).toHaveBeenCalledWith('root-folder', 'domain', 'retail');
  });

  it('upload: 上書き(updated)の場合は ?saved=updated に遷移する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    mocks.upsertTextFile.mockResolvedValue({ fileId: 'file-1', action: 'updated' });
    const location = await handleAdminKnowledgePost(
      stubPool(),
      viewer,
      uploadForm({ target: 'customer', customer_id: 'acme', file_name: 'profile.md', content: '更新' }),
    );
    expect(location).toBe('/admin/knowledge?saved=updated');
    expect(mocks.ensureSubfolder).toHaveBeenCalledWith('root-folder', 'customer', 'acme');
  });

  it('upload: 存在しない業界(マスタ照合 rowCount=0)は AIM-6004(400)で Drive に書き込まない', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(
          stubPool([], { rowCount: 0 }),
          viewer,
          uploadForm({ target: 'domain', industry_id: 'ghost', file_name: 'a.md', content: 'x' }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '存在しない業界',
    );
    expect(mocks.ensureSubfolder).not.toHaveBeenCalled();
  });

  it('upload: 格納先・ファイル名・本文の不正は AIM-6004(400)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const cases: URLSearchParams[] = [
      uploadForm({ target: 'root', file_name: 'a.md', content: 'x' }),
      uploadForm({ target: 'judgement', file_name: '不正な名前.md', content: 'x' }),
      uploadForm({ target: 'judgement', file_name: 'a.md', content: '   ' }),
      uploadForm({ target: 'judgement', file_name: 'a.md', content: 'x'.repeat(200 * 1024 + 1) }),
    ];
    for (const form of cases) {
      await expectAppErrorAsync(
        () => handleAdminKnowledgePost(stubPool(), viewer, form),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
      );
    }
    expect(mocks.upsertTextFile).not.toHaveBeenCalled();
  });

  it('delete: trashFile(ゴミ箱移動)を呼び ?saved=deleted に遷移する', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    const location = await handleAdminKnowledgePost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'delete', file_id: 'doc-1', file_name: 'profile.md' }),
    );
    expect(location).toBe('/admin/knowledge?saved=deleted');
    expect(mocks.trashFile).toHaveBeenCalledWith('doc-1');
  });

  it('delete: 形式不正なファイルIDは AIM-6004(400)で Drive に触れない', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(
          stubPool(),
          viewer,
          new URLSearchParams({ action: 'delete', file_id: "bad id'" }),
        ),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
    expect(mocks.trashFile).not.toHaveBeenCalled();
  });

  it('sync: OIDC ID トークン付きで /jobs/knowledge-sync を起動し JobSummary を PRG で渡す', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    const fetchCalls: Array<{ url: string; method?: string; auth?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        fetchCalls.push({ url: String(url), method: init?.method, auth: headers['authorization'] });
        return new Response(JSON.stringify({ job: 'knowledge-sync', sent: 2, skipped: 5, failed: 0 }), {
          status: 200,
        });
      }),
    );

    const location = await handleAdminKnowledgePost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'sync' }),
    );

    expect(mocks.getIdTokenFor).toHaveBeenCalledWith('https://batch.example.run.app');
    expect(fetchCalls).toEqual([
      {
        url: 'https://batch.example.run.app/jobs/knowledge-sync',
        method: 'POST',
        auth: 'Bearer id-token',
      },
    ]);
    expect(location).toBe('/admin/knowledge?synced=1&sent=2&skipped=5&failed=0');
  });

  it('sync: BATCH_URL 未設定は AIM-6004(400)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, new URLSearchParams({ action: 'sync' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'BATCH_URL',
    );
  });

  it('sync: 起動失敗は例外にせず sync_error=request へ PRG する(再読み込みで再起動しない)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    process.env['BATCH_URL'] = 'https://batch.example.run.app';
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect failed'))));
    const location = await handleAdminKnowledgePost(
      stubPool(),
      viewer,
      new URLSearchParams({ action: 'sync' }),
    );
    expect(location).toBe('/admin/knowledge?sync_error=request');
  });

  it('不明な action は AIM-6004(400)', async () => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, new URLSearchParams({ action: 'drop' })),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
    );
  });
});

describe('ナレッジ書込ハンドラ: ファイルアップロード(upload_files・v0.6)', () => {
  const filesForm = (fields: Record<string, string> = {}): URLSearchParams =>
    new URLSearchParams({ action: 'upload_files', target: 'judgement', ...fields });
  const file = (fileName: string, content: string | Buffer): MultipartFile => ({
    field: 'files',
    fileName,
    content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
  });

  beforeEach(() => {
    process.env['KNOWLEDGE_DRIVE_FOLDER_ID'] = 'root-folder';
  });

  it('複数ファイルを同じ格納先へ upsert し、新規・上書きの件数を PRG で渡す(受け入れ基準1)', async () => {
    mocks.upsertTextFile
      .mockResolvedValueOnce({ fileId: 'f1', action: 'created' })
      .mockResolvedValueOnce({ fileId: 'f2', action: 'updated' });
    const location = await handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
      file('a.md', '# A'),
      file('b.txt', 'B'),
    ]);
    expect(location).toBe('/admin/knowledge?uploaded=1&created=1&updated=1&failed=0');
    expect(mocks.ensureSubfolder).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSubfolder).toHaveBeenCalledWith('root-folder', 'judgement');
    expect(mocks.upsertTextFile).toHaveBeenNthCalledWith(1, 'target-folder', 'a.md', '# A');
    expect(mocks.upsertTextFile).toHaveBeenNthCalledWith(2, 'target-folder', 'b.txt', 'B');
  });

  it('ファイル名は小文字に変換して保存する(OS 由来の大文字を規約へ寄せる)', async () => {
    await handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [file('README.MD', 'x')]);
    expect(mocks.upsertTextFile).toHaveBeenCalledWith('target-folder', 'readme.md', 'x');
  });

  it('ファイル未選択は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, filesForm(), []),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'ファイルを選択',
    );
  });

  it('上限(10件)超過は AIM-6004(400)で何も保存しない', async () => {
    const files = Array.from({ length: 11 }, (_, i) => file(`f${i}.md`, 'x'));
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, filesForm(), files),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '10 件まで',
    );
    expect(mocks.upsertTextFile).not.toHaveBeenCalled();
  });

  it('拡張子 .md / .txt 以外は .md 自動付与で素通りさせず AIM-6004(400)', async () => {
    for (const bad of ['data.json', 'index.html', 'archive.tar.gz', 'readme']) {
      await expectAppErrorAsync(
        () => handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [file(bad, 'x')]),
        ERROR_CODES.ADMIN_INPUT_INVALID,
        400,
        '対応していない形式',
      );
    }
    expect(mocks.upsertTextFile).not.toHaveBeenCalled();
  });

  it('規約外のファイル名が1件でもあれば全件投入しない(受け入れ基準2)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
          file('ok.md', 'x'),
          file('日本語名.md', 'x'),
        ]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '日本語名.md',
    );
    expect(mocks.ensureSubfolder).not.toHaveBeenCalled();
    expect(mocks.upsertTextFile).not.toHaveBeenCalled();
  });

  it('小文字変換後の重複名は AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
          file('A.md', 'x'),
          file('a.md', 'y'),
        ]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '重複',
    );
  });

  it('200KB 超のファイルは AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
          file('big.md', Buffer.alloc(200 * 1024 + 1, 0x61)),
        ]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'big.md',
    );
  });

  it('UTF-8 でないファイルは AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
          // Shift_JIS の「あ」(0x82 0xA0)は UTF-8 として不正
          file('sjis.txt', Buffer.from([0x82, 0xa0])),
        ]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'UTF-8',
    );
  });

  it('内容が空のファイルは AIM-6004(400)', async () => {
    await expectAppErrorAsync(
      () => handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [file('empty.md', '  \n')]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      'empty.md',
    );
  });

  it('格納先(業界)の実在性はマスタで検証する(直接入力と共通の防御)', async () => {
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool([], { rowCount: 0 }), viewer, filesForm({ target: 'domain', industry_id: 'ghost' }), [
          file('a.md', 'x'),
        ]),
      ERROR_CODES.ADMIN_INPUT_INVALID,
      400,
      '存在しない業界',
    );
    expect(mocks.upsertTextFile).not.toHaveBeenCalled();
  });

  it('2件目以降の保存失敗は継続し、失敗件数とファイル名を PRG で渡す(原則4)', async () => {
    mocks.upsertTextFile
      .mockResolvedValueOnce({ fileId: 'f1', action: 'created' })
      .mockRejectedValueOnce(new Error('drive down'))
      .mockResolvedValueOnce({ fileId: 'f3', action: 'created' });
    const location = await handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [
      file('a.md', 'x'),
      file('b.md', 'y'),
      file('c.md', 'z'),
    ]);
    expect(location).toBe(
      `/admin/knowledge?uploaded=1&created=2&updated=0&failed=1&failed_names=${encodeURIComponent('b.md')}`,
    );
  });

  it('1件目からの保存失敗は設定不備の可能性が高いためそのままエラー表示にする(v0.6 §2)', async () => {
    mocks.upsertTextFile.mockRejectedValue(
      new AppError(ERROR_CODES.DRIVE_WRITE_FAILED, '編集者共有を確認してください', { status: 502 }),
    );
    await expectAppErrorAsync(
      () =>
        handleAdminKnowledgePost(stubPool(), viewer, filesForm(), [file('a.md', 'x'), file('b.md', 'y')]),
      ERROR_CODES.DRIVE_WRITE_FAILED,
      502,
    );
    expect(mocks.upsertTextFile).toHaveBeenCalledTimes(1);
  });
});
