import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDocument, fetchFileText } from '../src/drive.js';

const mocks = vi.hoisted(() => ({
  driveFetch: vi.fn<(url: string) => Promise<Response>>(),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, driveFetch: mocks.driveFetch };
});

describe('classifyDocument(M1 標準フォーマット+v0.3 業界帰属+v0.12 プロジェクト帰属)', () => {
  it('customer/{顧客ID}/profile.md → customer_profile', () => {
    expect(classifyDocument({ name: 'profile.md', path: 'customer/acme' })).toEqual({
      docType: 'customer_profile',
      customerId: 'acme',
      industryId: null,
      projectId: null,
    });
  });

  it('customer/{顧客ID}/glossary.md → glossary', () => {
    expect(classifyDocument({ name: 'glossary.md', path: 'customer/acme' })).toEqual({
      docType: 'glossary',
      customerId: 'acme',
      industryId: null,
      projectId: null,
    });
  });

  it('domain/{業界}/operations.md → domain_ops+業界帰属', () => {
    expect(classifyDocument({ name: 'operations.md', path: 'domain/logistics' })).toEqual({
      docType: 'domain_ops',
      customerId: null,
      industryId: 'logistics',
      projectId: null,
    });
  });

  it('domain 直下(業界セグメントなし)は industryId null', () => {
    expect(classifyDocument({ name: '共通.md', path: 'domain' })).toEqual({
      docType: 'domain_ops',
      customerId: null,
      industryId: null,
      projectId: null,
    });
  });

  it('judgement/decision-rules.md → decision_rules', () => {
    expect(classifyDocument({ name: 'decision-rules.md', path: 'judgement' })).toEqual({
      docType: 'decision_rules',
      customerId: null,
      industryId: null,
      projectId: null,
    });
  });

  it('judgement/analogy-library.md → analogy', () => {
    expect(classifyDocument({ name: 'analogy-library.md', path: 'judgement' })).toEqual({
      docType: 'analogy',
      customerId: null,
      industryId: null,
      projectId: null,
    });
  });

  it('project/{プロジェクトID}/*.md → project_doc+プロジェクト帰属(v0.12 §4)', () => {
    expect(classifyDocument({ name: 'plan.md', path: 'project/p1' })).toEqual({
      docType: 'project_doc',
      customerId: null,
      industryId: null,
      projectId: 'p1',
    });
  });

  it('project 直下(ID セグメントなし)は projectId null(domain と同じ扱い)', () => {
    expect(classifyDocument({ name: '共通.md', path: 'project' })).toEqual({
      docType: 'project_doc',
      customerId: null,
      industryId: null,
      projectId: null,
    });
  });

  it('フォーマット外はファイル名から推定し、既定は domain_ops', () => {
    expect(classifyDocument({ name: 'メモ.md', path: '' }).docType).toBe('domain_ops');
    expect(classifyDocument({ name: 'analogy集.md', path: '' }).docType).toBe('analogy');
  });
});

/** テキスト層を持つ最小の1ページ PDF(本文: Hello TSUNAGUBA)。 */
function minimalPdf(contentStream: string): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${contentStream.length} >> stream`,
      contentStream,
      'endstream endobj',
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      'xref',
      '0 6',
      'trailer << /Size 6 /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'),
    'latin1',
  );
}

function pdfResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

describe('fetchFileText: PDF のテキスト抽出(v0.11)', () => {
  const pdfFile = { id: 'pdf-1', name: '取引基準.pdf', mimeType: 'application/pdf', path: 'customer/acme' };

  beforeEach(() => {
    mocks.driveFetch.mockReset();
  });

  it('テキスト層のある PDF は本文を抽出して返す(実 PDF での検証)', async () => {
    mocks.driveFetch.mockResolvedValue(
      pdfResponse(minimalPdf('BT /F1 24 Tf 72 700 Td (Hello TSUNAGUBA) Tj ET')),
    );
    const text = await fetchFileText(pdfFile);
    expect(text).toContain('Hello TSUNAGUBA');
    expect(mocks.driveFetch).toHaveBeenCalledWith(expect.stringContaining('/files/pdf-1?alt=media'));
  });

  it('テキスト層のない PDF(スキャン画像等)は undefined でスキップする', async () => {
    mocks.driveFetch.mockResolvedValue(pdfResponse(minimalPdf('')));
    await expect(fetchFileText(pdfFile)).resolves.toBeUndefined();
  });

  it('列挙メタデータの size が上限(20MB)超ならダウンロードせずにスキップする(OOM 防止)', async () => {
    await expect(
      fetchFileText({ ...pdfFile, size: 20 * 1024 * 1024 + 1 }),
    ).resolves.toBeUndefined();
    expect(mocks.driveFetch).not.toHaveBeenCalled();
  });

  it('size が取得できない場合はダウンロード後の判定でスキップする(二段構え)', async () => {
    mocks.driveFetch.mockResolvedValue(pdfResponse(Buffer.alloc(20 * 1024 * 1024 + 1, 0x20)));
    await expect(fetchFileText(pdfFile)).resolves.toBeUndefined();
  });

  it('MIME が application/octet-stream でも拡張子 .pdf なら PDF として扱う', async () => {
    mocks.driveFetch.mockResolvedValue(
      pdfResponse(minimalPdf('BT /F1 12 Tf 72 700 Td (ext match) Tj ET')),
    );
    const text = await fetchFileText({ ...pdfFile, mimeType: 'application/octet-stream' });
    expect(text).toContain('ext match');
  });
});
