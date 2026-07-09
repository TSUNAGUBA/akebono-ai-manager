import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { badge, gapBadge, responsiveTable, section } from '../render/components.js';
import { html, raw, type Raw } from '../render/html.js';
import type { Viewer } from '../render/layout.js';

function formatDateKey(dateKey: number): string {
  const s = String(dateKey);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * わたしの振り返り(本人のみ)。
 * 自分の予想と結果の差分履歴を振り返り資産として本人に返す(要件 M5 / 7.5)。
 */
export async function renderMe(pool: pg.Pool, viewer: Viewer): Promise<Raw> {
  const outcomes = await query<{
    date_key: number;
    hypothesis_text: string | null;
    outcome_text: string | null;
    gap_category: string | null;
    next_change_stated: boolean;
  }>(
    pool,
    `SELECT fho.date_key, fho.hypothesis_text, fho.outcome_text, fho.gap_category, fho.next_change_stated
     FROM dwh.fact_hypothesis_outcome fho
     JOIN dwh.dim_user du ON du.user_key = fho.user_key
     WHERE du.user_id = $1
     ORDER BY fho.date_key DESC
     LIMIT 30`,
    [viewer.userId],
  );

  const suggestions = await query<{
    content: string;
    category: string;
    user_decision: string | null;
    decision_reason: string | null;
    created: string;
  }>(
    pool,
    `SELECT content, category, user_decision, decision_reason,
            to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'MM/DD') AS created
     FROM ops.suggestions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [viewer.userId],
  );

  const decisionLabel = (decision: string | null): Raw => {
    switch (decision) {
      case 'accepted':
        return badge('採用', 'ok');
      case 'rejected':
        return badge('見送り', 'muted');
      case 'modified':
        return badge('修正して採用', 'neutral');
      default:
        return badge('未回答', 'warn');
    }
  };

  return html`
    <p class="note">
      この記録は評価のためのものではなく、あなた自身の振り返り資産です。
      予想と結果の差分に「次に変えること」を添えられた日は、確実に前へ進んでいます。
    </p>
    ${section(
      '予想と結果の差分履歴',
      responsiveTable(
        [
          { key: 'date', label: '日付' },
          { key: 'hypothesis', label: '朝の仮説' },
          { key: 'outcome', label: '実際の結果' },
          { key: 'gap', label: '差分' },
          { key: 'nextChange', label: '次に変えること' },
        ],
        outcomes.rows.map((o) => ({
          date: formatDateKey(o.date_key),
          hypothesis: o.hypothesis_text ?? '—',
          outcome: o.outcome_text ?? '—',
          gap: gapBadge(o.gap_category),
          nextChange: o.next_change_stated ? raw(badge('言語化済み', 'ok').html) : raw(badge('なし', 'muted').html),
        })),
        { emptyText: 'まだ記録がありません。朝の問いかけに答えると、ここに積み上がっていきます' },
      ),
    )}
    ${section(
      'AI 提案へのあなたの判断',
      responsiveTable(
        [
          { key: 'created', label: '日付' },
          { key: 'content', label: '提案内容' },
          { key: 'decision', label: '判断' },
          { key: 'reason', label: '理由' },
        ],
        suggestions.rows.map((s) => ({
          created: s.created,
          content: s.content.length > 100 ? `${s.content.slice(0, 100)}…` : s.content,
          decision: decisionLabel(s.user_decision),
          reason: s.decision_reason ?? '—',
        })),
        { emptyText: 'AI からの提案はまだありません' },
      ),
      '「なぜ採用しなかったか」という判断も、チームの貴重な知恵として扱われます',
    )}
  `;
}
