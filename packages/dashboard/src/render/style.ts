/**
 * デザインシステム(単一ソース)。
 * 方針: シンプルで洗練された統一デザイン。余白と階層で情報を整理し、色は控えめに。
 * - ニュートラルな背景 + 単一アクセントカラー(藍)
 * - 全ページ同一のレイアウト・コンポーネント(カード / 統計 / テーブル / バッジ / バー)
 * - モバイルはテーブルをカード型レイアウトに切替(レスポンシブ対応)
 */
export const STYLESHEET = `
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --border: #e4e7ec;
  --text: #191f2b;
  --text-muted: #6b7484;
  --accent: #3651a5;
  --accent-soft: #eef1f9;
  --ok: #1e7f4f;
  --ok-soft: #e7f4ed;
  --warn: #9a6700;
  --warn-soft: #fcf1dc;
  --danger: #b3352c;
  --danger-soft: #fbebe9;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif;
  font-size: 15px;
  line-height: 1.65;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ── ヘッダー・ナビゲーション ── */
.site-header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.site-header .inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.brand {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.02em;
  padding: 14px 0;
  color: var(--text);
  white-space: nowrap;
}
.brand .dot { color: var(--accent); }
.nav {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.nav a {
  padding: 14px 12px;
  color: var(--text-muted);
  font-size: 14px;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.nav a:hover { color: var(--text); text-decoration: none; }
.nav a.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.viewer {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 13px;
  white-space: nowrap;
  padding: 14px 0;
}

/* ── レイアウト ── */
.container { max-width: 1080px; margin: 0 auto; padding: 28px 20px 64px; }
.page-title { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
.page-desc { color: var(--text-muted); font-size: 14px; margin: 0 0 24px; }

.section { margin-top: 32px; }
.section > h2 { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
.section > .section-desc { color: var(--text-muted); font-size: 13px; margin: 0 0 12px; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px;
}

/* ── 統計カード ── */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.stat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 18px;
}
.stat .label { color: var(--text-muted); font-size: 12.5px; }
.stat .value { font-size: 26px; font-weight: 700; line-height: 1.3; margin-top: 2px; }
.stat .sub { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.stat.tone-danger .value { color: var(--danger); }
.stat.tone-warn .value { color: var(--warn); }
.stat.tone-ok .value { color: var(--ok); }

/* ── テーブル(PC)/ カード(モバイル)── */
.rt { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.rt table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rt th, .rt td { padding: 10px 16px; text-align: left; vertical-align: top; }
.rt th {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  background: #fafbfc;
  white-space: nowrap;
}
.rt tbody tr + tr td { border-top: 1px solid var(--border); }
.rt td.num, .rt th.num { text-align: right; font-variant-numeric: tabular-nums; }
.rt .rt-cards { display: none; }

/* ── バッジ ── */
.badge {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.badge.neutral { background: var(--accent-soft); color: var(--accent); }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.danger { background: var(--danger-soft); color: var(--danger); }
.badge.muted { background: #eef0f3; color: var(--text-muted); }

/* ── 水平バー(簡易チャート)── */
.bars { display: grid; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 130px 1fr 70px; gap: 10px; align-items: center; font-size: 13px; }
.bar-row .bar-label { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { background: var(--accent-soft); border-radius: 6px; height: 10px; overflow: hidden; }
.bar-fill { background: var(--accent); height: 100%; border-radius: 6px; }
.bar-row .bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }

/* ── 実施ドット(朝夕の問答実施履歴)── */
.dots { display: flex; gap: 4px; }
.dots .dot-day { width: 12px; height: 12px; border-radius: 3px; background: #e8eaee; }
.dots .dot-day.on { background: var(--ok); }
.dots .dot-day.half { background: var(--warn); }

/* ── 空状態・注記 ── */
.empty {
  color: var(--text-muted);
  font-size: 14px;
  padding: 28px 20px;
  text-align: center;
}
.note {
  background: var(--accent-soft);
  border-radius: var(--radius);
  color: var(--accent);
  font-size: 13px;
  padding: 12px 16px;
  margin: 0 0 20px;
}

/* ── エラーページ ── */
.error-page { max-width: 560px; margin: 80px auto; text-align: center; }
.error-page .code { font-size: 40px; font-weight: 700; color: var(--text-muted); }

/* ── モバイル ── */
@media (max-width: 720px) {
  .container { padding: 20px 14px 48px; }
  .rt table { display: none; }
  .rt { background: transparent; border: none; box-shadow: none; }
  .rt .rt-cards { display: grid; gap: 10px; }
  .rt-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 14px 16px;
  }
  .rt-card .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 14px; }
  .rt-card .row .k { color: var(--text-muted); font-size: 12.5px; white-space: nowrap; }
  .rt-card .row .v { text-align: right; overflow-wrap: anywhere; }
  .bar-row { grid-template-columns: 90px 1fr 60px; }
}
`;
