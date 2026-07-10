import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { isAppError } from '../src/errors.js';
import { isMultipartRequest, readMultipartFormBody } from '../src/http.js';

const BOUNDARY = 'test-boundary-123';

function mockReq(body: Buffer | string, contentType?: string): http.IncomingMessage {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  const req = Readable.from([buf]) as unknown as http.IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {
    'content-type': contentType ?? `multipart/form-data; boundary=${BOUNDARY}`,
  };
  return req;
}

function fieldPart(name: string, value: string): string {
  return `--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function filePart(name: string, fileName: string, content: string): string {
  return (
    `--${BOUNDARY}\r\n` +
    `content-disposition: form-data; name="${name}"; filename="${fileName}"\r\n` +
    `content-type: text/markdown\r\n\r\n${content}\r\n`
  );
}

const CLOSE = `--${BOUNDARY}--\r\n`;

async function expectInvalid(body: string | Buffer, status: number, contentType?: string): Promise<void> {
  try {
    await readMultipartFormBody(mockReq(body, contentType));
  } catch (err) {
    expect(isAppError(err), 'AppError であること').toBe(true);
    if (isAppError(err)) expect(err.status).toBe(status);
    return;
  }
  expect.fail('例外が発生しませんでした');
}

describe('isMultipartRequest', () => {
  it('multipart/form-data(大文字小文字・パラメータ付き)を判定する', () => {
    expect(isMultipartRequest(mockReq(''))).toBe(true);
    expect(isMultipartRequest(mockReq('', 'Multipart/Form-Data; boundary=x'))).toBe(true);
    expect(isMultipartRequest(mockReq('', 'application/x-www-form-urlencoded'))).toBe(false);
  });
});

describe('readMultipartFormBody', () => {
  it('フィールドとファイル(CRLF・日本語本文を含む)を分離して読む', async () => {
    const content = '# 見出し\r\n\r\n日本語の本文。\nLF だけの行も保持する';
    const body =
      fieldPart('csrf_token', 'a'.repeat(64)) +
      fieldPart('action', 'upload_files') +
      filePart('files', 'notes.md', content) +
      CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.fields.get('csrf_token')).toBe('a'.repeat(64));
    expect(result.fields.get('action')).toBe('upload_files');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.field).toBe('files');
    expect(result.files[0]?.fileName).toBe('notes.md');
    expect(result.files[0]?.content.toString('utf8')).toBe(content);
  });

  it('同名フィールドの複数ファイルを順序どおり読む', async () => {
    const body = filePart('files', 'a.md', 'A') + filePart('files', 'b.txt', 'B') + CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.files.map((f) => f.fileName)).toEqual(['a.md', 'b.txt']);
    expect(result.files.map((f) => f.content.toString())).toEqual(['A', 'B']);
  });

  it('filename のパス要素(Windows / POSIX)はファイル名部分だけを使う', async () => {
    const body =
      filePart('files', 'C:\\\\Users\\\\yamashita\\\\docs\\\\win.md', 'w') +
      filePart('files', '/home/user/posix.md', 'p') +
      CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.files.map((f) => f.fileName)).toEqual(['win.md', 'posix.md']);
  });

  it('エスケープされた引用符を含む filename を復元する', async () => {
    const body =
      `--${BOUNDARY}\r\n` +
      `content-disposition: form-data; name="files"; filename="a\\"b.md"\r\n\r\nx\r\n` +
      CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.files[0]?.fileName).toBe('a"b.md');
  });

  it('ファイル未選択(filename が空)のパートはファイルとして扱わない', async () => {
    const body =
      `--${BOUNDARY}\r\n` +
      `content-disposition: form-data; name="files"; filename=""\r\n` +
      `content-type: application/octet-stream\r\n\r\n\r\n` +
      fieldPart('action', 'upload_files') +
      CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.files).toHaveLength(0);
    expect(result.fields.get('action')).toBe('upload_files');
  });

  it('boundary パラメータなしは AIM-3103(400)', async () => {
    await expectInvalid(fieldPart('a', '1') + CLOSE, 400, 'multipart/form-data');
  });

  it('終端デリミタなしは AIM-3103(400)', async () => {
    await expectInvalid(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="a"\r\n\r\nvalue`, 400);
  });

  it('Content-Disposition なしのパートは AIM-3103(400)', async () => {
    await expectInvalid(`--${BOUNDARY}\r\ncontent-type: text/plain\r\n\r\nx\r\n${CLOSE}`, 400);
  });

  it('全体サイズ超過(4MiB)は AIM-3103(413)', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024);
    await expectInvalid(filePart('files', 'big.md', big) + CLOSE, 413);
  });

  it('パート数超過は AIM-3103(400)、上限ちょうど(40 パート)は受理する', async () => {
    const parts = (n: number): string =>
      Array.from({ length: n }, (_, i) => fieldPart(`f${i}`, 'v')).join('') + CLOSE;
    await expectInvalid(parts(41), 400);
    const ok = await readMultipartFormBody(mockReq(parts(40)));
    expect([...ok.fields.keys()]).toHaveLength(40);
  });

  it('boundary の RFC 上限(70 文字)超過は AIM-3103(400)、上限ちょうどは受理する', async () => {
    // 長大 boundary は Buffer.indexOf の最悪計算量を突く CPU 消費に使えるため必ず弾く
    const build = (b: string): { body: string; type: string } => ({
      body: `--${b}\r\ncontent-disposition: form-data; name="a"\r\n\r\nv\r\n--${b}--\r\n`,
      type: `multipart/form-data; boundary=${b}`,
    });
    const tooLong = build('b'.repeat(71));
    await expectInvalid(tooLong.body, 400, tooLong.type);
    const max = build('b'.repeat(70));
    const ok = await readMultipartFormBody(mockReq(max.body, max.type));
    expect(ok.fields.get('a')).toBe('v');
  });

  it('本文にデリミタ風の文字列を含んでも境界(CRLF+デリミタ)でのみ区切る', async () => {
    const tricky = `本文中の --${BOUNDARY} は区切りではない(直前が CRLF でないため)`;
    const body = filePart('files', 'a.md', tricky) + CLOSE;
    const result = await readMultipartFormBody(mockReq(body));
    expect(result.files[0]?.content.toString('utf8')).toBe(tricky);
  });
});
