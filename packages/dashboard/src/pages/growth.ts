import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section } from '../render/components.js';
import { html, type Raw } from '../render/html.js';

function pct(value: string | null): string {
  return value === null ? '—' : `${Math.round(Number(value) * 100)}%`;
}

/**
 * 成長観察(管理者限定)。②層の成長と③層の兆候の観察データ(要件 M5)。
 * 人事評価の自動化ではなく、管理者の観察を補助するデータである(要件 2)。
 */
export async function renderGrowth(pool: pg.Pool): Promise<Raw> {
  const growth = await query<{
    display_name: string;
    year: number;
    month: number;
    morning_dialogues: string;
    hypothesis_rate: string | null;
    ai_assisted_rate: string | null;
    avg_response_chars: string | null;
    hypothesis_outcomes: string;
    small_gap_rate: string | null;
    next_change_rate: string | null;
  }>(
    pool,
    `SELECT display_name, year, month, morning_dialogues, hypothesis_rate, ai_assisted_rate,
            avg_response_chars, hypothesis_outcomes, small_gap_rate, next_change_rate
     FROM dwh.v_member_growth
     ORDER BY year DESC, month DESC, display_name
     LIMIT 36`,
  );

  const suggestions = await query<{
    display_name: string;
    category: string;
    suggestions: string;
    accepted: string;
    rejected: string;
    ignored: string;
    reason_stated_rate: string | null;
  }>(
    pool,
    `SELECT display_name, category, suggestions, accepted, rejected, ignored, reason_stated_rate
     FROM dwh.v_suggestion_pattern
     ORDER BY display_name, category`,
  );

  const knowledgeLoop = await query<{
    year: number;
    month: number;
    escalations: string;
    knowledge_reflected_count: string;
    knowledge_reflected_rate: string | null;
    avg_hours_to_resolve: string | null;
  }>(
    pool,
    `SELECT year, month, escalations, knowledge_reflected_count, knowledge_reflected_rate, avg_hours_to_resolve
     FROM dwh.v_knowledge_loop
     ORDER BY year DESC, month DESC
     LIMIT 12`,
  );

  const categoryLabels: Record<string, string> = {
    next_action: '次アクション',
    decomposition: 'タスク分解',
    priority: '優先順位',
    knowledge: 'ナレッジ',
  };

  return html`
    <p class="note">
      このページのデータは人事評価の自動化のためのものではなく、管理者の観察を補助するためのものです。
      解釈と評価は必ず人間が行ってください(社内規程に明文化)。
    </p>
    ${section(
      '仮説形成の推移(月次)',
      responsiveTable(
        [
          { key: 'member', label: 'メンバー' },
          { key: 'month', label: '月' },
          { key: 'morning', label: '朝の問答', numeric: true },
          { key: 'hypothesisRate', label: '仮説表明率', numeric: true },
          { key: 'aiAssistedRate', label: 'AI補助率', numeric: true },
          { key: 'avgChars', label: '回答の平均文字数', numeric: true },
          { key: 'smallGapRate', label: '予想的中傾向', numeric: true },
          { key: 'nextChangeRate', label: '次の一手の言語化率', numeric: true },
        ],
        growth.rows.map((g) => ({
          member: g.display_name,
          month: `${g.year}/${String(g.month).padStart(2, '0')}`,
          morning: g.morning_dialogues,
          hypothesisRate: pct(g.hypothesis_rate),
          aiAssistedRate: pct(g.ai_assisted_rate),
          avgChars: g.avg_response_chars ?? '—',
          smallGapRate: pct(g.small_gap_rate),
          nextChangeRate: pct(g.next_change_rate),
        })),
        { emptyText: '集計データがまだありません(夜間ETLの実行後に表示されます)' },
      ),
      'AI補助率が下がり仮説表明率が上がる推移が、②層(仮説形成)の成長シグナル',
    )}
    ${section(
      'AI 提案の採否パターン',
      responsiveTable(
        [
          { key: 'member', label: 'メンバー' },
          { key: 'category', label: 'カテゴリ' },
          { key: 'total', label: '提案数', numeric: true },
          { key: 'accepted', label: '採用', numeric: true },
          { key: 'rejected', label: '見送り', numeric: true },
          { key: 'ignored', label: '未回答', numeric: true },
          { key: 'reasonRate', label: '理由の言語化率', numeric: true },
        ],
        suggestions.rows.map((s) => ({
          member: s.display_name,
          category: categoryLabels[s.category] ?? s.category,
          total: s.suggestions,
          accepted: s.accepted,
          rejected: s.rejected,
          ignored: s.ignored,
          reasonRate: pct(s.reason_stated_rate),
        })),
        { emptyText: '集計データがまだありません' },
      ),
      '「なぜ採用しなかったか」の言語化は、意見表明(③層)の観察材料になる',
    )}
    ${section(
      'ナレッジ還流(エスカレーション → 判断基準への反映)',
      responsiveTable(
        [
          { key: 'month', label: '月' },
          { key: 'escalations', label: 'エスカレーション', numeric: true },
          { key: 'reflected', label: 'ナレッジ反映', numeric: true },
          { key: 'rate', label: '還流率', numeric: true },
          { key: 'hours', label: '平均解決時間(h)', numeric: true },
        ],
        knowledgeLoop.rows.map((k) => ({
          month: `${k.year}/${String(k.month).padStart(2, '0')}`,
          escalations: k.escalations,
          reflected: k.knowledge_reflected_count,
          rate: pct(k.knowledge_reflected_rate),
          hours: k.avg_hours_to_resolve ?? '—',
        })),
        { emptyText: '集計データがまだありません' },
      ),
      '還流率はキーパーソンリスク解消の進捗を示す KPI(要件 12)',
    )}
  `;
}
