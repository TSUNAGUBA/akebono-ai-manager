import {
  ESCALATION_ANSWER_PREFIX,
  getEscalation,
  logger,
  query,
  recordResolution,
  refluxResolutionToKnowledge,
  sendChatMessage,
  type EscalationRow,
} from '@ai-manager/shared';
import type pg from 'pg';
import { invalidJobParams, requireParam, requireTextParam, verifyAdminOperator } from '../job-validation.js';
import type { JobSummary } from './morning-checkin.js';

/**
 * ジョブパラメータ(v0.12 §3)。ダッシュボードのエスカレーション詳細から OIDC 経由で起動される。
 * action:
 *   answer    = メンバーへ回答を DM 送信して解決(resolution_type='admin_message')
 *   ruling    = 裁定を記録してナレッジへ還流(resolution_type='ruling')
 *   no_action = 回答不要として解決(還流・DM なし)
 *   reflux    = 還流の再試行(解決済み・未還流のもののみ — 手動回復パス)
 */
export interface EscalationActionParams {
  escalationId?: string;
  action?: string;
  text?: string;
  operatorUserId?: string;
}

const ACTIONS = ['answer', 'ruling', 'no_action', 'reflux'] as const;
type EscalationAction = (typeof ACTIONS)[number];

function isEscalationAction(value: string): value is EscalationAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/** 回答・裁定本文の上限(ダッシュボードのフォームと同じ制約をジョブ側でも検証)。 */
const TEXT_MAX_LENGTH = 1000;

/** no_action の既定の解決メモ(text 省略時)。 */
const NO_ACTION_DEFAULT_TEXT = '回答不要として解決';

/**
 * エスカレーション解決アクション(v0.12 §3)。
 * SoT は ops.escalations(recordResolution が open のみ更新するため、
 * 並行する Chat の裁定フローと競合しても解決済みを上書きしない — 原則2)。
 * 戻り値: 処理成功 sent=1 / 競合等のスキップ skipped=1 / DM 送信失敗 failed=1。
 */
export async function runEscalationAction(
  pool: pg.Pool,
  params: EscalationActionParams = {},
): Promise<JobSummary> {
  const escalationId = requireParam(params.escalationId, 'escalationId');
  const operatorUserId = requireParam(params.operatorUserId, 'operatorUserId');
  const action = requireParam(params.action, 'action');
  if (!isEscalationAction(action)) {
    throw invalidJobParams(`action は ${ACTIONS.join(' / ')} のいずれかで指定してください`, { action });
  }
  await verifyAdminOperator(pool, operatorUserId);

  const escalation = await getEscalation(pool, escalationId);
  if (escalation === undefined) {
    throw invalidJobParams('指定のエスカレーションが見つかりません', { escalationId });
  }

  switch (action) {
    case 'answer':
      return answerEscalation(pool, escalation, params.text, operatorUserId);
    case 'ruling':
      return recordRuling(pool, escalation, params.text, operatorUserId);
    case 'no_action':
      return resolveWithoutAction(pool, escalation, params.text, operatorUserId);
    case 'reflux':
      return refluxAgain(pool, escalation);
  }
}

/**
 * answer: メンバーへ回答を DM 送信して解決する。
 * adhoc-checkin と同じ SoT ファーストパターン: 対話レコード作成 → DM 送信 → 送信失敗時は
 * 補償削除して failed を返す(エスカレーションは open のまま残るため再操作できる)。
 * 解決の記録(recordResolution)は送信成功後に行う: 送信できていないのに resolved に
 * してしまうと「回答済みに見えるが本人に届いていない」状態になるため。
 */
async function answerEscalation(
  pool: pg.Pool,
  escalation: EscalationRow,
  textParam: string | undefined,
  operatorUserId: string,
): Promise<JobSummary> {
  const text = requireTextParam(textParam, 'text', TEXT_MAX_LENGTH);
  if (escalation.related_user_id === null) {
    throw invalidJobParams('対象メンバーのいないエスカレーションには回答を送信できません', {
      escalationId: escalation.escalation_id,
    });
  }
  // 解決済みへの再操作は DM を送らずスキップする(再実行しても本人へ二重送信しない — 原則2)
  if (escalation.status !== 'open') {
    logger.warn('エスカレーションが既に解決済みのため回答送信をスキップします', {
      escalationId: escalation.escalation_id,
      status: escalation.status,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }

  const member = await query<{ chat_space_id: string | null }>(
    pool,
    'SELECT chat_space_id FROM ops.users WHERE user_id = $1',
    [escalation.related_user_id],
  );
  const chatSpaceId = member.rows[0]?.chat_space_id ?? null;
  if (chatSpaceId === null) {
    throw invalidJobParams(
      '対象メンバーの DM スペースが未登録のため回答を送信できません(本人が Chat アプリに一度話しかけると登録されます)',
      { escalationId: escalation.escalation_id, userId: escalation.related_user_id },
    );
  }

  // 管理者経由の回答であることの明示(v0.12 §3)はコード側で必ず付与する(adhoc-checkin と同じ設計)
  const fullText = `${ESCALATION_ANSWER_PREFIX}\n${text}`;
  const inserted = await query<{ dialogue_id: string }>(
    pool,
    `INSERT INTO ops.dialogues (user_id, dialogue_type, turns)
     VALUES ($1, 'escalation', $2::jsonb)
     RETURNING dialogue_id`,
    [
      escalation.related_user_id,
      JSON.stringify([{ role: 'ai', content: fullText, ts: new Date().toISOString() }]),
    ],
  );
  const dialogueId = inserted.rows[0]?.dialogue_id;
  try {
    await sendChatMessage(chatSpaceId, { text: fullText });
  } catch (sendErr) {
    // 届いていない回答の対話レコードが残ると対話ログ上「回答済み」に見えてしまうため補償削除する。
    // エスカレーションは open のまま(解決の記録前)なので、オペレーターは再操作できる
    if (dialogueId !== undefined) {
      await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [dialogueId]).catch(
        (cleanupErr: unknown) => {
          logger.error('回答送信失敗後の対話レコード削除に失敗しました', cleanupErr, { dialogueId });
        },
      );
    }
    logger.error('エスカレーション回答の DM 送信に失敗しました(エスカレーションは open のまま)', sendErr, {
      escalationId: escalation.escalation_id,
      userId: escalation.related_user_id,
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  const resolved = await recordResolution(
    pool,
    escalation.escalation_id,
    operatorUserId,
    text,
    'admin_message',
  );
  if (resolved === undefined) {
    // 送信準備〜送信の間に別経路(Chat の裁定等)で解決された競合。解決済みは上書きしない(原則2)
    logger.warn('回答は送信しましたが、エスカレーションは別経路で解決済みでした(解決の記録をスキップ)', {
      escalationId: escalation.escalation_id,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }
  logger.info('エスカレーションへの回答を送信して解決しました', {
    escalationId: escalation.escalation_id,
    userId: escalation.related_user_id,
    dialogueId,
  });
  return { sent: 1, skipped: 0, failed: 0 };
}

/**
 * ruling: 裁定を記録し、ナレッジ(decision_rules)へ還流する。
 * 還流の失敗は非ブロッキング(原則4): SoT(裁定の記録)は保持され knowledge_reflected=false の
 * まま残るため、ダッシュボードの「再還流」(action='reflux')で回復できる(手動回復パス — 原則6)。
 */
async function recordRuling(
  pool: pg.Pool,
  escalation: EscalationRow,
  textParam: string | undefined,
  operatorUserId: string,
): Promise<JobSummary> {
  const text = requireTextParam(textParam, 'text', TEXT_MAX_LENGTH);
  const resolved = await recordResolution(pool, escalation.escalation_id, operatorUserId, text, 'ruling');
  if (resolved === undefined) {
    logger.warn('エスカレーションが既に解決済みのため裁定の記録をスキップします', {
      escalationId: escalation.escalation_id,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }
  try {
    await refluxResolutionToKnowledge(pool, resolved);
  } catch (err) {
    logger.warn('裁定のナレッジ還流に失敗しました(裁定の記録は保持。ダッシュボードの再還流で再試行できます)', {
      escalationId: escalation.escalation_id,
      error: String(err),
    });
  }
  logger.info('裁定を記録しました', { escalationId: escalation.escalation_id });
  return { sent: 1, skipped: 0, failed: 0 };
}

/** no_action: 回答不要として解決する(還流・DM なし)。 */
async function resolveWithoutAction(
  pool: pg.Pool,
  escalation: EscalationRow,
  textParam: string | undefined,
  operatorUserId: string,
): Promise<JobSummary> {
  // text は任意(省略時は既定メモ)。指定時は他アクションと同じ上限を検証する
  const text =
    textParam === undefined || textParam.trim() === ''
      ? NO_ACTION_DEFAULT_TEXT
      : requireTextParam(textParam, 'text', TEXT_MAX_LENGTH);
  const resolved = await recordResolution(pool, escalation.escalation_id, operatorUserId, text, 'no_action');
  if (resolved === undefined) {
    logger.warn('エスカレーションが既に解決済みのため回答不要の記録をスキップします', {
      escalationId: escalation.escalation_id,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }
  logger.info('エスカレーションを回答不要として解決しました', {
    escalationId: escalation.escalation_id,
  });
  return { sent: 1, skipped: 0, failed: 0 };
}

/**
 * reflux: 還流の再試行(手動回復パス — v0.12 §3)。
 * ruling と異なりオペレーターが明示的に還流を求めているため、失敗はジョブ失敗として
 * 返し(そのまま送出し)、ダッシュボード側でエラー表示させる。
 */
async function refluxAgain(pool: pg.Pool, escalation: EscalationRow): Promise<JobSummary> {
  if (escalation.status !== 'resolved') {
    throw invalidJobParams('解決済みのエスカレーションのみ再還流できます', {
      escalationId: escalation.escalation_id,
      status: escalation.status,
    });
  }
  // 還流対象は裁定のみ(NULL は v0.12 以前の未分類=裁定)。admin_message / no_action の
  // 解決メモをナレッジ化しない(ダッシュボード側も同条件で防御する二段構え — ADR-18)
  if (escalation.resolution_type !== null && escalation.resolution_type !== 'ruling') {
    throw invalidJobParams('裁定(ruling)以外の解決は再還流できません', {
      escalationId: escalation.escalation_id,
      resolutionType: escalation.resolution_type,
    });
  }
  if (escalation.knowledge_reflected) {
    // 既に還流済みの再実行は no-op(UPSERT のため再実行しても壊れないが、embedding の再計算コストを避ける)
    logger.info('既にナレッジへ還流済みのためスキップします', {
      escalationId: escalation.escalation_id,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }
  await refluxResolutionToKnowledge(pool, escalation);
  logger.info('裁定をナレッジへ再還流しました', { escalationId: escalation.escalation_id });
  return { sent: 1, skipped: 0, failed: 0 };
}
