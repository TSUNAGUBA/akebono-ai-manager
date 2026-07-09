import { describe, expect, it } from 'vitest';
import { escapeHtml, h, html, raw } from '../src/render/html.js';

describe('escapeHtml', () => {
  it('HTML 特殊文字をエスケープする', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("a & 'b'")).toBe('a &amp; &#39;b&#39;');
  });
});

describe('html タグ関数', () => {
  it('動的値を既定でエスケープする', () => {
    const out = html`<div>${'<b>危険</b>'}</div>`;
    expect(out.html).toBe('<div>&lt;b&gt;危険&lt;/b&gt;</div>');
  });

  it('Raw は素通しする', () => {
    const out = html`<div>${raw('<b>安全なマークアップ</b>')}</div>`;
    expect(out.html).toBe('<div><b>安全なマークアップ</b></div>');
  });

  it('配列は連結される', () => {
    const items = ['a', '<x>'];
    const out = html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`;
    expect(out.html).toBe('<ul><li>a</li><li>&lt;x&gt;</li></ul>');
  });

  it('null / undefined は空文字になる', () => {
    expect(h(null)).toBe('');
    expect(h(undefined)).toBe('');
    expect(h(0)).toBe('0');
  });
});
