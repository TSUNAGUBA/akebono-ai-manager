import { describe, expect, it } from 'vitest';
import {
  barList,
  checkinDots,
  gapBadge,
  responsiveTable,
  statCard,
} from '../src/render/components.js';

describe('responsiveTable', () => {
  it('テーブルとモバイルカードの両方を生成する(レスポンシブ対応)', () => {
    const out = responsiveTable(
      [
        { key: 'name', label: '名前' },
        { key: 'count', label: '件数', numeric: true },
      ],
      [{ name: '山田', count: 3 }],
    ).html;
    expect(out).toContain('<table>');
    expect(out).toContain('rt-cards');
    expect(out).toContain('山田');
    expect(out).toContain('class="num"');
  });

  it('セル値をエスケープする', () => {
    const out = responsiveTable(
      [{ key: 'v', label: 'V' }],
      [{ v: '<script>x</script>' }],
    ).html;
    expect(out).not.toContain('<script>x');
    expect(out).toContain('&lt;script&gt;');
  });

  it('空データは空状態を表示する', () => {
    const out = responsiveTable([{ key: 'v', label: 'V' }], [], { emptyText: 'なし' }).html;
    expect(out).toContain('なし');
    expect(out).not.toContain('<table>');
  });
});

describe('barList', () => {
  it('最大値を 100% として比率で描画する', () => {
    const out = barList([
      { label: 'a', value: 50 },
      { label: 'b', value: 100 },
    ]).html;
    expect(out).toContain('width:50%');
    expect(out).toContain('width:100%');
  });

  it('ゼロ値でも幅 1% 以上で描画する(ゼロ除算防止)', () => {
    const out = barList([{ label: 'a', value: 0 }]).html;
    expect(out).toContain('width:1%');
  });
});

describe('gapBadge', () => {
  it('差分カテゴリごとに意味のあるラベルを返す', () => {
    expect(gapBadge('none').html).toContain('予想通り');
    expect(gapBadge('opposite').html).toContain('正反対');
    expect(gapBadge(null).html).toContain('未分類');
  });
});

describe('statCard / checkinDots', () => {
  it('統計カードを描画する', () => {
    const out = statCard({ label: '進行中', value: 5, tone: 'ok' }).html;
    expect(out).toContain('進行中');
    expect(out).toContain('tone-ok');
  });

  it('朝夕実施状況をドットで描画する', () => {
    const out = checkinDots([
      { checkin: true, review: true },
      { checkin: true, review: false },
      { checkin: false, review: false },
    ]).html;
    expect(out.match(/dot-day on/g)).toHaveLength(1);
    expect(out.match(/dot-day half/g)).toHaveLength(1);
  });
});
