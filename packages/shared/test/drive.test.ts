import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, isAppError } from '../src/errors.js';
import { ensureSubfolder, listFilesRecursive, trashFile, upsertTextFile } from '../src/drive.js';

// トークン取得(ADC)はモックし、Drive API への fetch を検証する
vi.mock('../src/google-auth.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/google-auth.js')>();
  return { ...mod, getAccessToken: vi.fn(async () => 'test-token') };
});

interface FetchCall {
  url: string;
  method: string;
  contentType: string | undefined;
  body: string | undefined;
}

let calls: FetchCall[];
let responses: Response[];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        contentType: headers['content-type'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const res = responses.shift();
      if (res === undefined) throw new Error('想定外の fetch 呼び出しです');
      return res;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** URLSearchParams は空白を + にエンコードするため、+ も戻してからクエリを検証する。 */
function decodeQuery(url: string): string {
  return decodeURIComponent(url.replaceAll('+', ' '));
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

describe('listFilesRecursive(ルートフォルダの可視性検証)', () => {
  it('ルートが見える場合は files.get で確認してから配下を列挙する', async () => {
    responses.push(
      // 可視性プローブ(files.get)
      jsonResponse(200, { id: 'root-1', mimeType: 'application/vnd.google-apps.folder', trashed: false }),
      jsonResponse(200, {
        files: [
          { id: 'sub-1', name: 'customer', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'doc-1', name: 'rules.md', mimeType: 'text/markdown' },
        ],
      }),
      jsonResponse(200, { files: [{ id: 'doc-2', name: 'profile.md', mimeType: 'text/markdown' }] }),
    );
    const files = await listFilesRecursive('root-1');
    expect(calls[0]?.url).toContain('/files/root-1?');
    expect(files.map((f) => `${f.path}/${f.name}`)).toEqual(['/rules.md', 'customer/profile.md']);
  });

  it('ルートが未共有・ID 誤り(404)は「0件の成功」ではなく AIM-5003(Step 7-3 の案内付き・403)', async () => {
    // Drive の q 検索は「見える項目」しか返さないため、未共有は一覧空になる。
    // 先行する files.get の 404 を実アクションに変換できることを検証する
    responses.push(jsonResponse(404, { error: { message: 'File not found' } }));
    await expectAppErrorAsync(
      () => listFilesRecursive('ghost-folder'),
      ERROR_CODES.DRIVE_SYNC_FAILED,
      403,
      'Step 7-3',
    );
  });

  it('ルートへの権限なし(403)も同じ案内の AIM-5003', async () => {
    responses.push(jsonResponse(403, { error: { message: 'forbidden' } }));
    await expectAppErrorAsync(
      () => listFilesRecursive('root-1'),
      ERROR_CODES.DRIVE_SYNC_FAILED,
      403,
      'ランタイム SA に共有されているか',
    );
  });

  it('ゴミ箱内のフォルダ ID は AIM-5003(400)で可視化する(files.get は 200 を返すため)', async () => {
    responses.push(
      jsonResponse(200, { id: 'root-1', mimeType: 'application/vnd.google-apps.folder', trashed: true }),
    );
    await expectAppErrorAsync(
      () => listFilesRecursive('root-1'),
      ERROR_CODES.DRIVE_SYNC_FAILED,
      400,
      'ゴミ箱',
    );
  });

  it('フォルダでないファイルの ID は AIM-5003(400)で可視化する', async () => {
    responses.push(jsonResponse(200, { id: 'doc-1', mimeType: 'text/markdown', trashed: false }));
    await expectAppErrorAsync(
      () => listFilesRecursive('doc-1'),
      ERROR_CODES.DRIVE_SYNC_FAILED,
      400,
      'フォルダではなくファイル',
    );
  });

  it('一時障害(500 等)は共有案内に変換せず元のエラーのまま伝える', async () => {
    responses.push(jsonResponse(500, { error: { message: 'backend error' } }));
    await expectAppErrorAsync(
      () => listFilesRecursive('root-1'),
      ERROR_CODES.DRIVE_SYNC_FAILED,
      500,
      'Google Drive API がエラーを返しました',
    );
  });
});

describe('upsertTextFile(v0.4: 同名ファイルは上書き・なければ新規作成)', () => {
  it('既存あり: PATCH /upload(uploadType=media)で内容のみ更新する', async () => {
    responses.push(jsonResponse(200, { files: [{ id: 'file-1' }] }), jsonResponse(200, {}));

    const result = await upsertTextFile('folder-1', 'operations.md', '# 本文');

    expect(result).toEqual({ fileId: 'file-1', action: 'updated' });
    expect(calls).toHaveLength(2);
    // 検索: 同一フォルダ・同名・trashed=false
    const searchUrl = decodeQuery(calls[0]?.url ?? '');
    expect(searchUrl).toContain("'folder-1' in parents");
    expect(searchUrl).toContain("name = 'operations.md'");
    expect(searchUrl).toContain('trashed = false');
    expect(searchUrl).toContain('supportsAllDrives=true');
    // 更新: メディアアップロードで既存ファイルへ PATCH(新規作成しない)
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.url).toContain('/upload/drive/v3/files/file-1');
    expect(calls[1]?.url).toContain('uploadType=media');
    expect(calls[1]?.url).toContain('supportsAllDrives=true');
    expect(calls[1]?.body).toBe('# 本文');
  });

  it('既存なし: POST /upload(uploadType=multipart)で text/markdown として新規作成する', async () => {
    responses.push(jsonResponse(200, { files: [] }), jsonResponse(200, { id: 'new-1' }));

    const result = await upsertTextFile('folder-1', 'notes.md', '本文テキスト');

    expect(result).toEqual({ fileId: 'new-1', action: 'created' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/upload/drive/v3/files');
    expect(calls[1]?.url).toContain('uploadType=multipart');
    expect(calls[1]?.url).toContain('supportsAllDrives=true');
    expect(calls[1]?.contentType).toContain('multipart/related');
    // metadata パートにファイル名・親フォルダ・MIME、本文パートに内容が含まれる
    expect(calls[1]?.body).toContain('"name":"notes.md"');
    expect(calls[1]?.body).toContain('"parents":["folder-1"]');
    expect(calls[1]?.body).toContain('"mimeType":"text/markdown"');
    expect(calls[1]?.body).toContain('本文テキスト');
  });

  it('検索クエリのファイル名はエスケープされる(シングルクォート)', async () => {
    responses.push(jsonResponse(200, { files: [] }), jsonResponse(200, { id: 'new-2' }));
    await upsertTextFile('folder-1', "it's.md", 'x');
    const searchUrl = decodeQuery(calls[0]?.url ?? '');
    expect(searchUrl).toContain("name = 'it\\'s.md'");
  });

  it('権限エラー(403)は共有設定(Step 7-3)の確認を促す AIM-6006(403)', async () => {
    responses.push(jsonResponse(403, { error: { message: 'insufficient permissions' } }));
    await expectAppErrorAsync(
      () => upsertTextFile('folder-1', 'a.md', 'x'),
      ERROR_CODES.DRIVE_WRITE_FAILED,
      403,
      '編集者',
    );
  });

  it('未共有(404)も同じ案内(Step 7-3)を含む AIM-6006(403)', async () => {
    responses.push(jsonResponse(404, { error: { message: 'not found' } }));
    await expectAppErrorAsync(
      () => upsertTextFile('folder-1', 'a.md', 'x'),
      ERROR_CODES.DRIVE_WRITE_FAILED,
      403,
      'Step 7-3',
    );
  });

  it('権限以外の API エラー(500 等)は AIM-6006(502)', async () => {
    responses.push(jsonResponse(500, { error: { message: 'backend error' } }));
    await expectAppErrorAsync(
      () => upsertTextFile('folder-1', 'a.md', 'x'),
      ERROR_CODES.DRIVE_WRITE_FAILED,
      502,
    );
  });
});

describe('ensureSubfolder(サブフォルダの検索+なければ作成)', () => {
  it('既存フォルダはそのまま使い、なければ作成して folderId を返す', async () => {
    responses.push(
      jsonResponse(200, { files: [{ id: 'dir-customer' }] }), // customer は既存
      jsonResponse(200, { files: [] }), // acme は未作成
      jsonResponse(200, { id: 'dir-acme' }), // 作成
    );

    const folderId = await ensureSubfolder('root-1', 'customer', 'acme');

    expect(folderId).toBe('dir-acme');
    expect(calls).toHaveLength(3);
    const search1 = decodeQuery(calls[0]?.url ?? '');
    expect(search1).toContain("'root-1' in parents");
    expect(search1).toContain("name = 'customer'");
    expect(search1).toContain("mimeType = 'application/vnd.google-apps.folder'");
    const search2 = decodeQuery(calls[1]?.url ?? '');
    expect(search2).toContain("'dir-customer' in parents");
    expect(search2).toContain("name = 'acme'");
    // 作成はメタデータ POST(親は直前のフォルダ)
    expect(calls[2]?.method).toBe('POST');
    expect(calls[2]?.body).toContain('"name":"acme"');
    expect(calls[2]?.body).toContain('"parents":["dir-customer"]');
    expect(calls[2]?.body).toContain('"mimeType":"application/vnd.google-apps.folder"');
  });

  it('全セグメントが既存なら作成せずに folderId を返す(冪等)', async () => {
    responses.push(jsonResponse(200, { files: [{ id: 'dir-judgement' }] }));
    const folderId = await ensureSubfolder('root-1', 'judgement');
    expect(folderId).toBe('dir-judgement');
    expect(calls).toHaveLength(1);
  });
});

describe('trashFile(ゴミ箱移動: 物理削除しない)', () => {
  it('PATCH で trashed=true を送る', async () => {
    responses.push(jsonResponse(200, {}));
    await trashFile('file-9');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/drive/v3/files/file-9');
    expect(calls[0]?.url).toContain('supportsAllDrives=true');
    expect(calls[0]?.body).toBe('{"trashed":true}');
  });

  it('権限エラー(403)は AIM-6006(403)で共有設定の確認を促す', async () => {
    responses.push(jsonResponse(403, {}));
    await expectAppErrorAsync(() => trashFile('file-9'), ERROR_CODES.DRIVE_WRITE_FAILED, 403, 'Step 7-3');
  });
});
