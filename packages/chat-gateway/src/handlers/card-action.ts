import { confirmedReportCard, decidedSuggestionCard, query } from '@ai-manager/shared';
import type pg from 'pg';
import type { OpsUser } from '../auth.js';
import { actionName, actionParameters, type ChatEvent } from '../chat-event.js';
import { decideSuggestion, getSuggestion } from '../services/suggestions.js';

/**
 * CARD_CLICKED イベントのハンドラ。
 * Chat には actionResponse: UPDATE_MESSAGE でカードを差し替える応答を返す。
 * どちらの操作も冪等(2度押しで状態が巻き戻らない)。
 */
export async function handleCardAction(
  pool: pg.Pool,
  event: ChatEvent,
  user: OpsUser,
): Promise<unknown> {
  const name = actionName(event);
  const params = actionParameters(event);

  switch (name) {
    case 'confirm_report':
      return confirmReport(pool, user, params['reportId']);
    case 'decide_suggestion': {
      const decision = params['decision'] === 'accepted' ? 'accepted' : 'rejected';
      return decideSuggestionAction(pool, user, params['suggestionId'], decision);
    }
    default:
      return { text: `不明な操作です(${name ?? 'unknown'})` };
  }
}

async function confirmReport(
  pool: pg.Pool,
  user: OpsUser,
  reportId: string | undefined,
): Promise<unknown> {
  if (reportId === undefined) return { text: '対象の日報が見つかりませんでした。' };

  // 本人の日報のみ確認可能。既に確認済みでもエラーにしない(冪等)
  await query(
    pool,
    `UPDATE ops.reports SET confirmed_by_user = TRUE
     WHERE report_id = $1 AND user_id = $2 AND report_type = 'daily'`,
    [reportId, user.user_id],
  );
  const result = await query<{ report_date: string; content: string; confirmed_by_user: boolean }>(
    pool,
    `SELECT report_date::text AS report_date, content, confirmed_by_user
     FROM ops.reports WHERE report_id = $1 AND user_id = $2`,
    [reportId, user.user_id],
  );
  const report = result.rows[0];
  if (report === undefined) return { text: '対象の日報が見つかりませんでした。' };

  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [confirmedReportCard(report.report_date, report.content)],
  };
}

async function decideSuggestionAction(
  pool: pg.Pool,
  user: OpsUser,
  suggestionId: string | undefined,
  decision: 'accepted' | 'rejected',
): Promise<unknown> {
  if (suggestionId === undefined) return { text: '対象の提案が見つかりませんでした。' };

  const updated = await decideSuggestion(pool, suggestionId, user.user_id, decision);
  if (updated !== undefined) {
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [decidedSuggestionCard(updated.content, decision)],
    };
  }
  // 既に決定済み: 記録済みの決定を表示するだけ(巻き戻さない)
  const existing = await getSuggestion(pool, suggestionId, user.user_id);
  if (existing === undefined) return { text: '対象の提案が見つかりませんでした。' };
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [decidedSuggestionCard(existing.content, existing.user_decision ?? 'rejected')],
  };
}
