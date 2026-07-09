import { AppError, ERROR_CODES, getAccessToken, SCOPES } from '@ai-manager/shared';

/**
 * Google Drive REST クライアント(ナレッジ同期用・読み取り専用)。
 * ナレッジフォルダはランタイム SA に「閲覧者」で共有しておくこと。
 */
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ナレッジルートからの相対フォルダパス(例: 'customer/acme') */
  path: string;
}

interface FilesListResponse {
  files?: Array<{ id?: string; name?: string; mimeType?: string }>;
  nextPageToken?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

async function driveFetch(url: string): Promise<Response> {
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

async function listChildren(folderId: string): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const children: Array<{ id: string; name: string; mimeType: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType),nextPageToken',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    const json = (await res.json()) as FilesListResponse;
    for (const f of json.files ?? []) {
      if (f.id !== undefined && f.name !== undefined && f.mimeType !== undefined) {
        children.push({ id: f.id, name: f.name, mimeType: f.mimeType });
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
        files.push({ id: child.id, name: child.name, mimeType: child.mimeType, path: current.path });
      }
    }
  }
  return files;
}

/**
 * ファイル本文をテキストとして取得する。
 * Google ドキュメントは text/plain でエクスポート、テキスト系ファイルはそのままダウンロード。
 * 対応外の形式は undefined(スキップ)。
 */
export async function fetchFileText(file: DriveFile): Promise<string | undefined> {
  if (file.mimeType === GOOGLE_DOC_MIME) {
    const res = await driveFetch(
      `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent('text/plain')}`,
    );
    return res.text();
  }
  if (
    file.mimeType.startsWith('text/') ||
    file.mimeType === 'application/json' ||
    file.name.endsWith('.md')
  ) {
    const res = await driveFetch(`${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`);
    return res.text();
  }
  return undefined;
}

export type DocType = 'customer_profile' | 'glossary' | 'domain_ops' | 'decision_rules' | 'analogy';

export interface DocClassification {
  docType: DocType;
  customerId: string | null;
  /** domain/{業界}/ の {業界} セグメント。マスタとの突合は knowledge-sync 側で行う(v0.3 §3.4) */
  industryId: string | null;
}

/**
 * フォルダパスとファイル名から doc_type / customer_id / industry_id を決める(要件 M1+v0.3 §3.4)。
 *   customer/{顧客ID}/profile.md   → customer_profile
 *   customer/{顧客ID}/glossary.md  → glossary
 *   domain/{業界}/operations.md    → domain_ops(業界は ops.industries の industry_id)
 *   judgement/decision-rules.md    → decision_rules
 *   judgement/analogy-library.md   → analogy
 */
export function classifyDocument(file: Pick<DriveFile, 'name' | 'path'>): DocClassification {
  const segments = file.path === '' ? [] : file.path.split('/');
  const top = segments[0]?.toLowerCase();
  const name = file.name.toLowerCase();

  if (top === 'customer') {
    const customerId = segments[1] ?? null;
    return {
      docType: name.includes('glossary') ? 'glossary' : 'customer_profile',
      customerId,
      industryId: null,
    };
  }
  if (top === 'judgement') {
    return {
      docType: name.includes('analogy') ? 'analogy' : 'decision_rules',
      customerId: null,
      industryId: null,
    };
  }
  if (top === 'domain') {
    return { docType: 'domain_ops', customerId: null, industryId: segments[1] ?? null };
  }
  // ルート直下などフォーマット外: ファイル名から推定し、既定はドメイン知識
  if (name.includes('analogy')) return { docType: 'analogy', customerId: null, industryId: null };
  if (name.includes('decision'))
    return { docType: 'decision_rules', customerId: null, industryId: null };
  if (name.includes('glossary')) return { docType: 'glossary', customerId: null, industryId: null };
  return { docType: 'domain_ops', customerId: null, industryId: null };
}
