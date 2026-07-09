/**
 * レポート生成のための対話ログ整形(純関数・テスト対象)。
 */
export interface DialogueDigestRow {
  dialogue_type: string;
  created_at: Date;
  turns: Array<{ role: 'ai' | 'user'; content: string; ts?: string }>;
  hypothesis: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
}

const TYPE_LABELS: Record<string, string> = {
  morning_checkin: '朝の問答',
  completion_review: '夕の振り返り',
  adhoc_qa: '質問対応',
  task_instruction: 'タスク指示',
  escalation: 'エスカレーション',
};

const MAX_TURN_CHARS = 200;
const MAX_DIGEST_CHARS = 6000;

function jstTimeLabel(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(11, 16);
}

/** LLM に渡す当日対話ダイジェストを組み立てる。 */
export function buildDialogueDigest(rows: DialogueDigestRow[]): string {
  const sections: string[] = [];
  for (const row of [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
    const label = TYPE_LABELS[row.dialogue_type] ?? row.dialogue_type;
    const lines: string[] = [`### ${jstTimeLabel(row.created_at)} ${label}`];
    for (const turn of row.turns) {
      const speaker = turn.role === 'ai' ? 'AI' : '本人';
      const content =
        turn.content.length > MAX_TURN_CHARS
          ? `${turn.content.slice(0, MAX_TURN_CHARS)}…`
          : turn.content;
      lines.push(`${speaker}: ${content.replaceAll('\n', ' ')}`);
    }
    if (row.hypothesis !== null) {
      lines.push(`(確定した仮説: ${JSON.stringify(row.hypothesis)})`);
    }
    if (row.review !== null) {
      lines.push(`(振り返り: ${JSON.stringify(row.review)})`);
    }
    sections.push(lines.join('\n'));
  }
  const digest = sections.join('\n\n');
  return digest.length > MAX_DIGEST_CHARS ? `${digest.slice(0, MAX_DIGEST_CHARS)}…` : digest;
}

/** LLM 不調時のフォールバック日報(対話ログの機械的な整形)。 */
export function fallbackDailyReport(rows: DialogueDigestRow[]): string {
  const completedReviews = rows.filter((r) => r.review !== null);
  const lines = [
    '## 本日の作業',
    ...rows.map((r) => `- ${TYPE_LABELS[r.dialogue_type] ?? r.dialogue_type}(${jstTimeLabel(r.created_at)})`),
    '',
    '## 朝の仮説と結果',
  ];
  const hypothesisRow = rows.find((r) => r.hypothesis !== null);
  if (hypothesisRow?.hypothesis != null) {
    lines.push(`- 仮説: ${String((hypothesisRow.hypothesis as { position?: unknown }).position ?? '')}`);
  } else {
    lines.push('- (仮説の記録なし)');
  }
  for (const r of completedReviews) {
    const review = r.review as { actual_outcome?: unknown; next_change?: unknown };
    lines.push(`- 結果: ${String(review.actual_outcome ?? '')}`);
    lines.push(`- 次に変えること: ${String(review.next_change ?? '')}`);
  }
  lines.push('', '※ この日報は自動整形版です(AI 生成が利用できなかったため)。');
  return lines.join('\n');
}
