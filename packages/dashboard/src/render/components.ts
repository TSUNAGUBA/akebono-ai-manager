import { h, html, raw, Raw, type HtmlValue } from './html.js';

/** 統計カード */
export function statCard(options: {
  label: string;
  value: HtmlValue;
  sub?: string;
  tone?: 'ok' | 'warn' | 'danger';
}): Raw {
  const tone = options.tone === undefined ? '' : ` tone-${options.tone}`;
  return html`<div class="stat${raw(tone)}">
    <div class="label">${options.label}</div>
    <div class="value">${options.value}</div>
    ${options.sub === undefined ? '' : html`<div class="sub">${options.sub}</div>`}
  </div>`;
}

export function statGrid(cards: Raw[]): Raw {
  return html`<div class="stat-grid">${cards}</div>`;
}

export interface Column {
  key: string;
  label: string;
  numeric?: boolean;
}

/**
 * レスポンシブテーブル: PC ではテーブル、モバイルではカード型レイアウト(原則8)。
 * 同じデータから両方のマークアップを生成し、CSS で切り替える。
 */
export function responsiveTable(
  columns: Column[],
  rows: Array<Record<string, HtmlValue>>,
  options: { emptyText?: string } = {},
): Raw {
  if (rows.length === 0) {
    return html`<div class="rt"><div class="empty">${options.emptyText ?? 'データがありません'}</div></div>`;
  }
  const header = columns
    .map((c) => `<th${c.numeric === true ? ' class="num"' : ''}>${h(c.label)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => `<td${c.numeric === true ? ' class="num"' : ''}>${h(row[c.key])}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const cards = rows
    .map(
      (row) =>
        `<div class="rt-card">${columns
          .map((c) => `<div class="row"><span class="k">${h(c.label)}</span><span class="v">${h(row[c.key])}</span></div>`)
          .join('')}</div>`,
    )
    .join('');
  return raw(
    `<div class="rt"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table><div class="rt-cards">${cards}</div></div>`,
  );
}

export function badge(text: string, tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'muted'): Raw {
  return html`<span class="badge ${raw(tone)}">${text}</span>`;
}

/** gap_category(仮説と結果の差分)のバッジ表現。全ページ共通の意味づけ。 */
export function gapBadge(gap: string | null): Raw {
  switch (gap) {
    case 'none':
      return badge('予想通り', 'ok');
    case 'minor':
      return badge('小さな差分', 'neutral');
    case 'major':
      return badge('大きな差分', 'warn');
    case 'opposite':
      return badge('正反対', 'danger');
    default:
      return badge('未分類', 'muted');
  }
}

/** タスク状態のバッジ表現。 */
export function statusBadge(status: string): Raw {
  switch (status) {
    case 'in_progress':
      return badge('進行中', 'neutral');
    case 'blocked':
      return badge('ブロック', 'danger');
    case 'done':
      return badge('完了', 'ok');
    case 'approved':
      return badge('承認済み', 'muted');
    case 'proposed':
      return badge('提案中', 'muted');
    case 'cancelled':
      return badge('中止', 'muted');
    case 'open':
      return badge('未対応', 'warn');
    case 'resolved':
      return badge('対応済み', 'ok');
    default:
      return badge(status, 'muted');
  }
}

/** 水平バー(簡易チャート)。値は最大値に対する比率で描画する。 */
export function barList(
  items: Array<{ label: string; value: number; display?: string }>,
): Raw {
  if (items.length === 0) return html`<div class="empty">データがありません</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  const rows = items
    .map((i) => {
      const width = Math.max(1, Math.round((i.value / max) * 100));
      return `<div class="bar-row">
        <span class="bar-label">${h(i.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
        <span class="bar-value">${h(i.display ?? String(i.value))}</span>
      </div>`;
    })
    .join('');
  return raw(`<div class="bars">${rows}</div>`);
}

/** 朝夕の問答実施履歴ドット(直近N日)。 */
export function checkinDots(
  days: Array<{ checkin: boolean; review: boolean }>,
): Raw {
  const dots = days
    .map((d) => {
      const cls = d.checkin && d.review ? 'on' : d.checkin || d.review ? 'half' : '';
      return `<span class="dot-day ${cls}"></span>`;
    })
    .join('');
  return raw(`<span class="dots">${dots}</span>`);
}

export function section(title: string, body: Raw, desc?: string): Raw {
  return html`<section class="section">
    <h2>${title}</h2>
    ${desc === undefined ? '' : html`<p class="section-desc">${desc}</p>`}
    ${body}
  </section>`;
}
