/**
 * HTML 文字列の安全な組み立て。
 * すべての動的値は既定でエスケープし、意図的な HTML 埋め込みは Raw でマークする。
 */
export class Raw {
  constructor(readonly html: string) {}
}

export function raw(html: string): Raw {
  return new Raw(html);
}

export type HtmlValue = string | number | null | undefined | Raw;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function h(value: HtmlValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Raw) return value.html;
  return escapeHtml(String(value));
}

/** テンプレートリテラルタグ: html`<div>${userInput}</div>` */
export function html(strings: TemplateStringsArray, ...values: Array<HtmlValue | HtmlValue[]>): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    const value = values[i];
    if (value === undefined && i >= values.length) return;
    if (Array.isArray(value)) {
      out += value.map(h).join('');
    } else {
      out += h(value);
    }
  });
  return new Raw(out);
}
