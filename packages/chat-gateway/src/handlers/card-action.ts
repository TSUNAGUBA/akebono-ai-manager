import {
  confirmedReportCard,
  decidedSuggestionCard,
  escalationRecordingCard,
  escalationRefluxRetryCard,
  escalationResolvedCard,
  isRefluxableResolutionType,
  logger,
  query,
  taskStateCard,
} from '@ai-manager/shared';
import type pg from 'pg';
import type { OpsUser } from '../auth.js';
import { actionName, actionParameters, type ChatEvent } from '../chat-event.js';
import {
  getEscalation,
  refluxResolutionToKnowledge,
  requestResolutionRecording,
} from '../services/escalations.js';
import { decideSuggestion, getSuggestion } from '../services/suggestions.js';
import {
  approveTask,
  cancelTask,
  completeTaskFromDialogue,
  deliverTaskToAssignee,
  getTask,
} from '../services/tasks.js';

/**
 * CARD_CLICKED イベントのハンドラ。
 * Chat には actionResponse: UPDATE_MESSAGE でカードを差し替える応答を返す。
 * すべての操作は冪等(2度押しで状態が巻き戻らない)。
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
    case 'decide_task': {
      const decision = params['decision'] === 'approve' ? 'approve' : 'reject';
      return decideTaskAction(pool, user, params['taskId'], decision);
    }
    case 'confirm_task_done': {
      const decision = params['decision'] === 'done' ? 'done' : 'dismiss';
      return confirmTaskDoneAction(pool, user, params['taskId'], decision);
    }
    case 'record_resolution':
      return recordResolutionAction(pool, user, params['escalationId']);
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

// ── タスク承認・却下(M3)────────────────────────────────────────

/** 既に決定済みのタスクの現在状態カードを返す(2度押し時: 巻き戻さない・再配信しない)。 */
async function currentTaskStateCard(pool: pg.Pool, taskId: string): Promise<unknown> {
  const task = await getTask(pool, taskId);
  if (task === undefined) return { text: '対象のタスクが見つかりませんでした。' };
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [taskStateCard(task.title, task.status, 'このタスクは処理済みです。')],
  };
}

async function decideTaskAction(
  pool: pg.Pool,
  user: OpsUser,
  taskId: string | undefined,
  decision: 'approve' | 'reject',
): Promise<unknown> {
  if (taskId === undefined) return { text: '対象のタスクが見つかりませんでした。' };
  if (user.role !== 'admin') return { text: 'タスクの承認・却下は管理者のみ行えます。' };

  if (decision === 'reject') {
    const cancelled = await cancelTask(pool, taskId);
    if (cancelled === undefined) return currentTaskStateCard(pool, taskId);
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [taskStateCard(cancelled.title, 'cancelled')],
    };
  }

  const approved = await approveTask(pool, taskId, user.user_id);
  if (approved === undefined) return currentTaskStateCard(pool, taskId);

  // メンバーへの DM 配信(補助処理): 失敗しても承認は巻き戻さず、結果を管理者に伝える
  const requesterName = await resolveRequesterName(pool, approved.requester_id, user.display_name);
  const delivery = await deliverTaskToAssignee(pool, approved, requesterName);
  const note = delivery.delivered
    ? `承認を記録し、${delivery.note}着手・完了は本人の対話から自動で反映されます。`
    : `承認は記録しましたが、${delivery.note}`;
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [taskStateCard(approved.title, 'approved', note)],
  };
}

async function resolveRequesterName(
  pool: pg.Pool,
  requesterId: string | null,
  fallback: string,
): Promise<string> {
  if (requesterId === null) return fallback;
  try {
    const result = await query<{ display_name: string }>(
      pool,
      `SELECT display_name FROM ops.users WHERE user_id = $1`,
      [requesterId],
    );
    return result.rows[0]?.display_name ?? fallback;
  } catch (err) {
    logger.error('依頼者名の取得に失敗しました(承認者名で継続)', err, { requesterId });
    return fallback;
  }
}

// ── タスク完了確認(M3: 対話からの進捗更新)──────────────────────

async function confirmTaskDoneAction(
  pool: pg.Pool,
  user: OpsUser,
  taskId: string | undefined,
  decision: 'done' | 'dismiss',
): Promise<unknown> {
  if (taskId === undefined) return { text: '対象のタスクが見つかりませんでした。' };

  if (decision === 'dismiss') {
    // 本人のタスクのみ表示する(他人のタスク情報を返さない)。状態は変更しない
    const task = await getTask(pool, taskId);
    if (task === undefined || task.assignee_id !== user.user_id) {
      return { text: '対象のタスクが見つかりませんでした。' };
    }
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [
        taskStateCard(
          task.title,
          task.status,
          '完了としては記録しませんでした。完了したら、また教えてください。',
        ),
      ],
    };
  }

  const completed = await completeTaskFromDialogue(pool, taskId, user.user_id);
  if (completed !== undefined) {
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [taskStateCard(completed.title, 'done', '完了として記録しました。おつかれさまでした。')],
    };
  }
  // 既に完了済みの場合は現在状態を表示するだけ(巻き戻さない)。本人のタスク以外は表示しない
  const task = await getTask(pool, taskId);
  if (task === undefined || task.assignee_id !== user.user_id) {
    return { text: '対象のタスクが見つかりませんでした。' };
  }
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [taskStateCard(task.title, task.status)],
  };
}

// ── 裁定の記録(M6: ナレッジ還流)────────────────────────────────

async function recordResolutionAction(
  pool: pg.Pool,
  user: OpsUser,
  escalationId: string | undefined,
): Promise<unknown> {
  if (escalationId === undefined) return { text: '対象のエスカレーションが見つかりませんでした。' };
  if (user.role !== 'admin') return { text: '裁定の記録は管理者のみ行えます。' };

  const awaiting = await requestResolutionRecording(pool, escalationId, user.user_id);
  if (awaiting !== undefined) {
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [escalationRecordingCard(escalationId, awaiting.reason, awaiting.context)],
    };
  }

  const existing = await getEscalation(pool, escalationId);
  if (existing === undefined) return { text: '対象のエスカレーションが見つかりませんでした。' };

  // 裁定済みだが未還流(還流失敗後の再実行): SoT の裁定からキャッシュへ再還流する(手動回復パス)。
  // 還流できるのは裁定(ruling / NULL=v0.12 以前の未分類)のみ(v0.12 §3 / ADR-18):
  // ダッシュボードの解決アクションが作る admin_message(回答文)・no_action(解決メモ)は
  // knowledge_reflected=false のまま残るが、decision_rules ナレッジ化してはならない
  // (batch の reflux アクション・ダッシュボードの再還流表示と同じ shared の判定を使う)
  if (
    existing.status === 'resolved' &&
    !existing.knowledge_reflected &&
    existing.resolution !== null &&
    isRefluxableResolutionType(existing.resolution_type)
  ) {
    try {
      await refluxResolutionToKnowledge(pool, existing);
      return {
        actionResponse: { type: 'UPDATE_MESSAGE' },
        cardsV2: [escalationResolvedCard(escalationId, existing.reason, existing.resolution)],
      };
    } catch (err) {
      logger.error('裁定のナレッジ再還流に失敗しました', err, { escalationId });
      // 再試行ボタン付きカードに差し替え、時間をおいて再度到達できるようにする(冪等)
      return {
        actionResponse: { type: 'UPDATE_MESSAGE' },
        cardsV2: [escalationRefluxRetryCard(escalationId, existing.reason, existing.resolution)],
      };
    }
  }

  // 裁定済み・還流済み: 記録済みの裁定を表示するだけ(巻き戻さない)
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [
      escalationResolvedCard(escalationId, existing.reason, existing.resolution ?? '(裁定なし)'),
    ],
  };
}
