import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from './errors.js';
import { getAccessToken, SCOPES } from './google-auth.js';

/**
 * Google Drive REST クライアント(batch のナレッジ同期と dashboard のナレッジ管理 UI で共用)。
 * - 読取(一覧・本文取得)は drive.readonly スコープ。フォルダの「閲覧者」共有で足りる
 * - 書込(投入・上書き・ゴミ箱移動)は drive スコープ+「編集者」共有が必要(v0.4 §3)
 *
 * 書込はランタイム SA 自身のトークンで行う(ドメイン全体委任は使わない)。
 * SA がアクセスできるのは明示的に共有されたフォルダのみであり、
 * Drive の共有 ACL が実効的な権限境界になる(要件 v0.4 §2)。
 */
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/** ナレッジ管理 UI から投入するテキスト文書の MIME タイプ。 */
const TEXT_FILE_MIME = 'text/markdown';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ナレッジルートからの相対フォルダパス(例: 'customer/acme') */
  path: string;
  /** Drive 側の最終更新日時(RFC3339)。一覧表示用の補助情報 */
  modifiedTime?: string;
}

interface FilesListResponse {
  files?: Array<{ id?: string; name?: string; mimeType?: string; modifiedTime?: string }>;
  nextPageToken?: string;
}

/** 読取用の Drive API fetch(drive.readonly)。失敗は AIM-5003。 */
export async function driveFetch(url: string): Promise<Response> {
  const token = await getAccessToken([SCOPES.DRIVE_READONLY]);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } }).catch(
    (err: unknown) => {
      throw new AppError(ERROR_CODES.DRIVE_SYNC_FAILED, 'Google Drive への接続に失敗しました', {
        cause: err,
      });
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(ERROR_CODES.DRIVE_SYNC_FAILED, `Google Drive API がエラーを返しました (HTTP ${res.status})`, {
      details: { status: res.status, body: body.slice(0, 300), url: url.split('?')[0] },
    });
  }
  return res;
}

type DriveChild = { id: string; name: string; mimeType: string; modifiedTime?: string };

async function listChildren(folderId: string): Promise<DriveChild[]> {
  const children: DriveChild[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime),nextPageToken',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    const json = (await res.json()) as FilesListResponse;
    for (const f of json.files ?? []) {
      if (f.id !== undefined && f.name !== undefined && f.mimeType !== undefined) {
        children.push({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime });
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken !== undefined);
  return children;
}

/** ナレッジフォルダ配下を再帰的に列挙する(フォルダパス付き)。 */
export async function listFilesRecursive(rootFolderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: '' }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.id)) continue;
    visited.add(current.id);

    const children = await listChildren(current.id);
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) {
        queue.push({
          id: child.id,
          path: current.path === '' ? child.name : `${current.path}/${child.name}`,
        });
      } else {
        files.push({
          id: child.id,
          name: child.name,
          mimeType: child.mimeType,
          path: current.path,
          modifiedTime: child.modifiedTime,
        });
      }
    }
  }
  return files;
}

// ── 書込系(ナレッジ管理 UI: 要件 v0.4)──────────────────────────────────

/**
 * 書込フロー用の Drive API fetch(drive スコープ)。検索を含む書込フロー全体で使い、
 * 権限エラー(403/404)は共有設定の確認方法を含むメッセージで報告する(v0.4 受け入れ基準3)。
 * 403/404 は status 403(画面バナー表示)、その他は status 502(ログで詳細確認)。
 */
async function driveWriteFetch(
  url: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; contentType?: string; body?: string },
): Promise<Response> {
  const token = await getAccessToken([SCOPES.DRIVE]);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  const res = await fetch(url, { method: init.method, headers, body: init.body }).catch(
    (err: unknown) => {
      throw new AppError(ERROR_CODES.DRIVE_WRITE_FAILED, 'Google Drive への接続に失敗しました', {
        status: 502,
        cause: err,
      });
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const details = { status: res.status, body: body.slice(0, 300), url: url.split('?')[0] };
    if (res.status === 403 || res.status === 404) {
      throw new AppError(
        ERROR_CODES.DRIVE_WRITE_FAILED,
        `Google Drive の権限エラーです (HTTP ${res.status})。ナレッジフォルダがランタイム SA に「編集者」で共有されているか確認してください(deployment-setup.md Step 7-3)`,
        { status: 403, details },
      );
    }
    throw new AppError(
      ERROR_CODES.DRIVE_WRITE_FAILED,
      `Google Drive API がエラーを返しました (HTTP ${res.status})`,
      { status: 502, details },
    );
  }
  return res;
}

/** Drive クエリ(q=)の文字列リテラル用エスケープ。 */
function escapeQueryValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

/** 親フォルダ直下から名前で1件検索する(フォルダ or ファイル)。見つからなければ undefined。 */
async function findChildByName(
  parentId: string,
  name: string,
  options: { foldersOnly: boolean },
): Promise<string | undefined> {
  const conditions = [
    `'${escapeQueryValue(parentId)}' in parents`,
    `name = '${escapeQueryValue(name)}'`,
    'trashed = false',
  ];
  // foldersOnly=false は「ファイル探し」なので同名フォルダを誤ヒットさせない
  // (フォルダに media PATCH すると Drive 側エラーになるため)
  if (options.foldersOnly) conditions.push(`mimeType = '${FOLDER_MIME}'`);
  else conditions.push(`mimeType != '${FOLDER_MIME}'`);
  const params = new URLSearchParams({
    q: conditions.join(' and '),
    fields: 'files(id)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await driveWriteFetch(`${DRIVE_API}/files?${params.toString()}`, { method: 'GET' });
  const json = (await res.json()) as FilesListResponse;
  return json.files?.[0]?.id;
}

/**
 * サブフォルダ('customer/acme' 等)を検索し、なければ作成して folderId を返す(冪等)。
 * 例: ensureSubfolder(rootId, 'customer', 'acme')
 */
export async function ensureSubfolder(parentId: string, ...pathSegments: string[]): Promise<string> {
  let currentId = parentId;
  for (const segment of pathSegments) {
    const found = await findChildByName(currentId, segment, { foldersOnly: true });
    if (found !== undefined) {
      currentId = found;
      continue;
    }
    const res = await driveWriteFetch(`${DRIVE_API}/files?supportsAllDrives=true`, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ name: segment, mimeType: FOLDER_MIME, parents: [currentId] }),
    });
    const created = (await res.json()) as { id?: string };
    if (created.id === undefined) {
      throw new AppError(ERROR_CODES.DRIVE_WRITE_FAILED, 'フォルダ作成のレスポンスに id が含まれていません', {
        status: 502,
        details: { name: segment },
      });
    }
    currentId = created.id;
  }
  return currentId;
}

/**
 * テキストファイルの投入(上書き優先: v0.4 §1)。
 * 同名ファイル(trashed=false)があれば内容のみ更新し、なければ text/markdown で新規作成する。
 * 再実行しても重複ファイルは生えない(冪等)。
 */
export async function upsertTextFile(
  folderId: string,
  fileName: string,
  content: string,
): Promise<{ fileId: string; action: 'created' | 'updated' }> {
  const existingId = await findChildByName(folderId, fileName, { foldersOnly: false });

  if (existingId !== undefined) {
    await driveWriteFetch(
      `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=media&supportsAllDrives=true`,
      { method: 'PATCH', contentType: TEXT_FILE_MIME, body: content },
    );
    return { fileId: existingId, action: 'updated' };
  }

  // multipart/related でメタデータ+本文を一括作成する
  const boundary = `aim-${randomUUID()}`;
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: TEXT_FILE_MIME });
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${TEXT_FILE_MIME}; charset=UTF-8`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const res = await driveWriteFetch(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true`,
    { method: 'POST', contentType: `multipart/related; boundary=${boundary}`, body },
  );
  const created = (await res.json()) as { id?: string };
  if (created.id === undefined) {
    throw new AppError(ERROR_CODES.DRIVE_WRITE_FAILED, 'ファイル作成のレスポンスに id が含まれていません', {
      status: 502,
      details: { fileName },
    });
  }
  return { fileId: created.id, action: 'created' };
}

/**
 * ファイルを Drive のゴミ箱へ移動する(物理削除はしない: 誤操作から復元可能に保つ)。
 * 対応するチャンクは次回の knowledge-sync で掃除される。
 */
export async function trashFile(fileId: string): Promise<void> {
  await driveWriteFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'PATCH',
    contentType: 'application/json',
    body: JSON.stringify({ trashed: true }),
  });
}
