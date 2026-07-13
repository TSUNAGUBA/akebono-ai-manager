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
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const PDF_MIME = 'application/pdf';

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
  /**
   * ショートカット経由で列挙されたファイルの、ショートカット自体の ID。
   * id はショートカット先(実体)を指す。ナレッジからの削除はショートカットを
   * ゴミ箱へ移動する(実体は元の場所に残す — v0.11)
   */
  shortcutId?: string;
}

/** ナレッジフォルダ配下の列挙結果。 */
export interface DriveFolderListing {
  files: DriveFile[];
  /**
   * アクセスできなかったショートカット(先のフォルダが SA に共有されていない等)。
   * ショートカットは共有権限を引き継がないため、実体側の共有が必要(v0.11)。
   * 同期側はこれが空でない場合、削除掃除をスキップして既存チャンクを保護する
   */
  unresolvedShortcuts: Array<{ name: string; path: string }>;
}

interface FilesListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    shortcutDetails?: { targetId?: string; targetMimeType?: string };
  }>;
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

type DriveChild = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

async function listChildren(folderId: string): Promise<DriveChild[]> {
  const children: DriveChild[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,shortcutDetails),nextPageToken',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    const json = (await res.json()) as FilesListResponse;
    for (const f of json.files ?? []) {
      if (f.id !== undefined && f.name !== undefined && f.mimeType !== undefined) {
        children.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          shortcutDetails: f.shortcutDetails,
        });
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken !== undefined);
  return children;
}

/**
 * ナレッジフォルダ配下を再帰的に列挙する(フォルダパス付き)。
 * ショートカット(v0.11)は実体へ解決して辿る。ただしショートカットは Drive の
 * 共有権限を引き継がないため、実体側が SA に共有されていないと先を読めない —
 * その場合は全体を止めず unresolvedShortcuts に記録して継続する(原則4)。
 * 実体フォルダ(ショートカット経由でない)の列挙失敗は従来どおり例外(設定不備の顕在化)。
 */
export async function listFilesRecursive(rootFolderId: string): Promise<DriveFolderListing> {
  const filesById = new Map<string, DriveFile>();
  const unresolvedShortcuts: DriveFolderListing['unresolvedShortcuts'] = [];
  const queue: Array<{ id: string; path: string; viaShortcutName?: string }> = [
    { id: rootFolderId, path: '' },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.id)) continue;
    visited.add(current.id);

    let children: DriveChild[];
    try {
      children = await listChildren(current.id);
    } catch (err) {
      if (current.viaShortcutName !== undefined) {
        unresolvedShortcuts.push({ name: current.viaShortcutName, path: current.path });
        continue;
      }
      throw err;
    }
    for (const child of children) {
      const childPath = current.path === '' ? child.name : `${current.path}/${child.name}`;
      if (child.mimeType === FOLDER_MIME) {
        queue.push({ id: child.id, path: childPath });
      } else if (child.mimeType === SHORTCUT_MIME) {
        const targetId = child.shortcutDetails?.targetId;
        if (targetId === undefined) {
          unresolvedShortcuts.push({ name: child.name, path: current.path });
        } else if (child.shortcutDetails?.targetMimeType === FOLDER_MIME) {
          queue.push({ id: targetId, path: childPath, viaShortcutName: child.name });
        } else if (!filesById.has(targetId)) {
          // 同一実体が実体・ショートカットの両方で見える場合は実体を優先する
          // (実体は下の分岐で無条件に set され、この登録を上書きする)
          filesById.set(targetId, {
            id: targetId,
            name: child.name,
            mimeType: child.shortcutDetails?.targetMimeType ?? 'application/octet-stream',
            path: current.path,
            modifiedTime: child.modifiedTime,
            shortcutId: child.id,
          });
        }
      } else {
        filesById.set(child.id, {
          id: child.id,
          name: child.name,
          mimeType: child.mimeType,
          path: current.path,
          modifiedTime: child.modifiedTime,
        });
      }
    }
  }
  return { files: [...filesById.values()], unresolvedShortcuts };
}

// ── 書込系(ナレッジ管理 UI: 要件 v0.4)──────────────────────────────────

/**
 * 書込フロー用の Drive API fetch(drive スコープ)。検索を含む書込フロー全体で使い、
 * 権限エラー(403/404)は共有設定の確認方法を含むメッセージで報告する(v0.4 受け入れ基準3)。
 * 403/404 は status 403(画面バナー表示)、その他は status 502(ログで詳細確認)。
 */
async function driveWriteFetch(
  url: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; contentType?: string; body?: string | Uint8Array },
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
 * ファイルの投入(上書き優先: v0.4 §1)。
 * 同名ファイル(trashed=false)があれば内容のみ更新し、なければ指定 MIME で新規作成する。
 * 再実行しても重複ファイルは生えない(冪等)。
 * content が文字列の場合は UTF-8 テキスト、Uint8Array の場合はバイナリ(PDF 等 — v0.11)。
 */
export async function upsertFile(
  folderId: string,
  fileName: string,
  content: string | Uint8Array,
  mimeType: string,
): Promise<{ fileId: string; action: 'created' | 'updated' }> {
  const existingId = await findChildByName(folderId, fileName, { foldersOnly: false });

  if (existingId !== undefined) {
    await driveWriteFetch(
      `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=media&supportsAllDrives=true`,
      { method: 'PATCH', contentType: mimeType, body: content },
    );
    return { fileId: existingId, action: 'updated' };
  }

  // multipart/related でメタデータ+本文を一括作成する
  const boundary = `aim-${randomUUID()}`;
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType });
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    typeof content === 'string' ? `Content-Type: ${mimeType}; charset=UTF-8` : `Content-Type: ${mimeType}`,
    '',
    '',
  ].join('\r\n');
  const tail = `\r\n--${boundary}--\r\n`;
  // テキストは従来どおり文字列ボディ、バイナリは Buffer 連結(文字コード変換を避ける)
  const body =
    typeof content === 'string'
      ? head + content + tail
      : Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content), Buffer.from(tail, 'utf8')]);
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

/** テキストファイルの投入(text/markdown)。upsertFile の従来 I/F 互換ラッパー。 */
export async function upsertTextFile(
  folderId: string,
  fileName: string,
  content: string,
): Promise<{ fileId: string; action: 'created' | 'updated' }> {
  return upsertFile(folderId, fileName, content, TEXT_FILE_MIME);
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
