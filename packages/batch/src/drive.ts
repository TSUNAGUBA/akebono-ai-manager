import { DRIVE_API, driveFetch, GOOGLE_DOC_MIME, logger, PDF_MIME, type DriveFile } from '@ai-manager/shared';

/**
 * Google Drive ナレッジ文書の本文取得と分類(ナレッジ同期の batch 固有ロジック)。
 * 低レベル API(driveFetch / listFilesRecursive / DriveFile 型等)は
 * shared/src/drive.ts に共通化されている(ナレッジ管理 UI と共用: v0.4)。
 * ナレッジフォルダのランタイム SA への共有は deployment-setup.md Step 7-3 を参照
 * (同期のみなら閲覧者で足りるが、ナレッジ管理 UI の投入・削除には編集者が必要)。
 */

/** 同期時に PDF テキスト抽出を試みるサイズ上限(メモリ保護。超過はスキップ+警告)。 */
const PDF_MAX_SYNC_BYTES = 20 * 1024 * 1024;

/**
 * PDF のテキスト層を抽出する(v0.11 / ADR-17)。抽出はバッチ内でローカルに行い、
 * 外部 API(Vertex 等)は使わない(同期のたびに全文を再抽出してもコストゼロのため、
 * チャンクの content_hash 差分比較という既存の冪等フローにそのまま乗る)。
 */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // pdfjs(unpdf)は重いため、PDF を実際に処理するときだけ読み込む
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * ファイル本文をテキストとして取得する。
 * Google ドキュメントは text/plain でエクスポート、テキスト系ファイルはそのままダウンロード、
 * PDF はテキスト層を抽出する(v0.11)。対応外の形式・テキスト層のない PDF は undefined(スキップ)。
 */
export async function fetchFileText(file: DriveFile): Promise<string | undefined> {
  if (file.mimeType === GOOGLE_DOC_MIME) {
    const res = await driveFetch(
      `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent('text/plain')}`,
    );
    return res.text();
  }
  if (file.mimeType === PDF_MIME || file.name.toLowerCase().endsWith('.pdf')) {
    const res = await driveFetch(`${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > PDF_MAX_SYNC_BYTES) {
      logger.warn('PDF がサイズ上限を超えるため同期をスキップします', {
        docId: file.id,
        name: file.name,
        bytes: bytes.byteLength,
        maxBytes: PDF_MAX_SYNC_BYTES,
      });
      return undefined;
    }
    const text = await extractPdfText(bytes);
    if (text.trim() === '') {
      logger.warn('PDF にテキスト層がないため同期をスキップします(スキャン画像のみの PDF は検索対象にできません)', {
        docId: file.id,
        name: file.name,
      });
      return undefined;
    }
    return text;
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
