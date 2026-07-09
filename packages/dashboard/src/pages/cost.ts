import { query } from '@ai-manager/shared';
import type pg from 'pg';
import { barList, responsiveTable, section, statCard, statGrid } from '../render/components.js';
import { html, type Raw } from '../render/html.js';

/** AI コスト(管理者限定)。日次・モデル別のコスト監視(要件 9: v_ai_cost での日次監視)。 */
export async function renderCost(pool: pg.Pool): Promise<Raw> {
  const daily = await query<{ day: string; cost_usd: string; dialogues: string }>(
    pool,
    `SELECT to_char(full_date, 'MM/DD') AS day, sum(cost_usd) AS cost_usd, sum(dialogues) AS dialogues
     FROM dwh.v_ai_cost
     WHERE full_date >= current_date - INTERVAL '30 days'
     GROUP BY full_date
     ORDER BY full_date`,
  );

  const byModel = await query<{
    model_used: string | null;
    dialogues: string;
    input_tokens: string | null;
    output_tokens: string | null;
    cost_usd: string;
  }>(
    pool,
    `SELECT model_used, sum(dialogues) AS dialogues, sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens, sum(cost_usd) AS cost_usd
     FROM dwh.v_ai_cost
     WHERE full_date >= current_date - INTERVAL '30 days'
     GROUP BY model_used
     ORDER BY sum(cost_usd) DESC NULLS LAST`,
  );

  const totalCost = daily.rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const totalDialogues = daily.rows.reduce((sum, r) => sum + Number(r.dialogues ?? 0), 0);

  return html`
    <p class="note">
      金額は概算単価による目安です(実際の請求は GCP の課金レポートが正)。
      予算アラートは GCP プロジェクト側で 50% / 80% / 100% の段階で設定します。
    </p>
    ${statGrid([
      statCard({ label: '直近30日の概算コスト', value: `$${totalCost.toFixed(2)}` }),
      statCard({ label: '対話セッション数', value: String(totalDialogues) }),
      statCard({
        label: '1対話あたり',
        value: totalDialogues === 0 ? '—' : `$${(totalCost / totalDialogues).toFixed(4)}`,
      }),
    ])}
    ${section(
      '日次コスト(直近30日)',
      html`<div class="card">${barList(
        daily.rows.map((r) => ({
          label: r.day,
          value: Number(r.cost_usd ?? 0),
          display: `$${Number(r.cost_usd ?? 0).toFixed(3)}`,
        })),
      )}</div>`,
    )}
    ${section(
      'モデル別内訳(直近30日)',
      responsiveTable(
        [
          { key: 'model', label: 'モデル' },
          { key: 'dialogues', label: '対話数', numeric: true },
          { key: 'inputTokens', label: '入力トークン', numeric: true },
          { key: 'outputTokens', label: '出力トークン', numeric: true },
          { key: 'cost', label: '概算コスト', numeric: true },
        ],
        byModel.rows.map((m) => ({
          model: m.model_used ?? '(不明)',
          dialogues: m.dialogues,
          inputTokens: m.input_tokens ?? '0',
          outputTokens: m.output_tokens ?? '0',
          cost: `$${Number(m.cost_usd ?? 0).toFixed(3)}`,
        })),
        { emptyText: '集計データがまだありません(夜間ETLの実行後に表示されます)' },
      ),
      'Flash 系がデフォルト、Pro は思考支援のみに使うルーティング方針(要件 6.5)の実測確認用',
    )}
  `;
}
