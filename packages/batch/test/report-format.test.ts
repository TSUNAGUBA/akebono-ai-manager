import { describe, expect, it } from 'vitest';
import { buildDialogueDigest, fallbackDailyReport, type DialogueDigestRow } from '../src/report-format.js';

const rows: DialogueDigestRow[] = [
  {
    dialogue_type: 'completion_review',
    created_at: new Date('2026-07-09T08:00:00Z'), // JST 17:00
    turns: [
      { role: 'user', content: 'A社の在庫連携、終わりました' },
      { role: 'ai', content: '朝の予想と比べてどうでしたか?' },
    ],
    hypothesis: null,
    review: { actual_outcome: '予定通り完了', gap_analysis: 'ほぼ想定通り', next_change: '事前にテストデータを用意する', gap_category: 'minor' },
  },
  {
    dialogue_type: 'morning_checkin',
    created_at: new Date('2026-07-08T23:30:00Z'), // JST 08:30
    turns: [
      { role: 'ai', content: 'おはようございます。今日の作業の位置づけは?' },
      { role: 'user', content: 'A社の在庫連携バッチの結合テストです' },
    ],
    hypothesis: { position: 'A社導入の最終工程', success_criteria: '全ケース通過', expected_obstacles: 'テストデータ不足', ai_assisted: false },
    review: null,
  },
];

describe('buildDialogueDigest', () => {
  it('時系列(JST)順に並び、種別ラベルと発話を含む', () => {
    const digest = buildDialogueDigest(rows);
    const morningPos = digest.indexOf('朝の問答');
    const eveningPos = digest.indexOf('夕の振り返り');
    expect(morningPos).toBeGreaterThanOrEqual(0);
    expect(eveningPos).toBeGreaterThan(morningPos);
    expect(digest).toContain('本人: A社の在庫連携バッチの結合テストです');
    expect(digest).toContain('08:30');
  });

  it('長い発話は切り詰められる', () => {
    const digest = buildDialogueDigest([
      {
        dialogue_type: 'adhoc_qa',
        created_at: new Date(),
        turns: [{ role: 'user', content: 'あ'.repeat(500) }],
        hypothesis: null,
        review: null,
      },
    ]);
    expect(digest).toContain('…');
    expect(digest.length).toBeLessThan(500);
  });
});

describe('fallbackDailyReport', () => {
  it('仮説と振り返りを機械的に整形する', () => {
    const report = fallbackDailyReport(rows);
    expect(report).toContain('## 本日の作業');
    expect(report).toContain('A社導入の最終工程');
    expect(report).toContain('次に変えること: 事前にテストデータを用意する');
    expect(report).toContain('自動整形版');
  });

  it('仮説がない日も破綻しない', () => {
    const report = fallbackDailyReport([
      {
        dialogue_type: 'adhoc_qa',
        created_at: new Date(),
        turns: [{ role: 'user', content: '質問' }],
        hypothesis: null,
        review: null,
      },
    ]);
    expect(report).toContain('(仮説の記録なし)');
  });
});
