import {
  ESCALATION_ANSWER_PREFIX,
  getEscalation,
  isRefluxableResolutionType,
  logger,
  query,
  recordResolution,
  refluxResolutionToKnowledge,
  RESOLUTION_TEXT_MAX_LENGTH,
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

/** no_action の既定の解決メモ(text 省略時)。 */
const NO_ACTION_DEFAULT_TEXT = '回答不要として解決';

/**
 * エスカレーション解決アクション(v0.12 §3)。
 * SoT は ops.escalations(recordResolution が open のみ更新するため、
 * 並行する Chat の裁定フローと競合しても解決済みを上書きしない — 原則2)。
 * 戻り値: 処理成功 sent=1 / 競合等のスキップ skipped=1 / DM 送信失敗 failed=1
 * (ruling の還流のみ失敗は sent=1+failed=1: 記録成功・還流失敗の区別)。
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
 *
 * クレームファースト設計(並行実行の二重 DM 防止):
 * recordResolution(open → resolved の条件付き UPDATE)を送信前のアトミックなクレームとして
 * 使う。並行する2つのリクエストのうちクレームに成功した一方だけが DM を送信でき、
 * 敗者は skipped で終わる(送信後に記録する順序だと、両者が送信してから片方だけ記録される
 * 二重 DM が起きる)。送信失敗時は対話レコードの補償削除に加えてエスカレーションを open へ
 * 戻し、オペレーターが再操作できるようにする。
 *
 * 既知の制約(残余ウィンドウ): クレーム後〜送信前にプロセスが落ちた場合、
 * 「resolved だが未送達」の状態が残る(補償が走れない数百ミリ秒の窓)。この場合
 * エスカレーションは open に戻らないため、オペレーターは再操作ではなく本人への
 * 送達状況の確認が必要になる(対話ログに escalation 対話が無いことで判別できる)。
 *
 * 既知の制約(裁定受付ゲートの副作用): recordResolution はクレーム成功時に同一管理者の
 * 他の open な裁定受付ゲート(Chat の「裁定を記録」押下状態)もクリアする。送信失敗の
 * 補償ではこのゲートは復元しない(復元は誤キャプチャ方向のリスクがあり、ゲートは
 * ボタンの再押下で安全に回復できるため — 安全側に倒す)。
 */
async function answerEscalation(
  pool: pg.Pool,
  escalation: EscalationRow,
  textParam: string | undefined,
  operatorUserId: string,
): Promise<JobSummary> {
  const text = requireTextParam(textParam, 'text', RESOLUTION_TEXT_MAX_LENGTH);
  if (escalation.related_user_id === null) {
    throw invalidJobParams('対象メンバーのいないエスカレーションには回答を送信できません', {
      escalationId: escalation.escalation_id,
    });
  }
  // 配信先の検証はクレームより先に行う(DM 未登録でクレームだけ立てて巻き戻す無駄を避ける)
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

  // クレーム: open → resolved の条件付き UPDATE。undefined は並行敗者(既に解決済み)で、
  // DM を送らずスキップする(二重送信の防止 — 原則2。解決済みも上書きしない)
  const resolved = await recordResolution(
    pool,
    escalation.escalation_id,
    operatorUserId,
    text,
    'admin_message',
  );
  if (resolved === undefined) {
    logger.warn('エスカレーションが既に解決済みのため回答送信をスキップします(並行操作との競合を含む)', {
      escalationId: escalation.escalation_id,
      status: escalation.status,
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }

  // 管理者経由の回答であることの明示(v0.12 §3)はコード側で必ず付与する(adhoc-checkin と同じ設計)
  const fullText = `${ESCALATION_ANSWER_PREFIX}\n${text}`;
  // クレーム後の失敗(対話レコード INSERT・DM 送信のどちらでも)は必ず補償を通す:
  // INSERT の一時的な DB エラーで例外がそのまま伝播すると、補償が走らず
  // 「resolved だが未送達」がプロセス生存中に確定してしまう(監査指摘 — 原則4)
  let dialogueId: string | undefined;
  try {
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
    dialogueId = inserted.rows[0]?.dialogue_id;
    await sendChatMessage(chatSpaceId, { text: fullText });
  } catch (sendErr) {
    // 補償: 届いていない回答の対話レコードを削除し、クレームしたエスカレーションを open へ戻す
    // (resolved のままだと「回答済みに見えるが本人に届いていない」不整合が残る)。
    // status='resolved' 条件付きで、他プロセスの解決を誤って巻き戻さない
    // (resolved → open の遷移はこの補償のみ。クレーム成立中は他プロセスが open 条件の
    //  recordResolution でクレームできないため、誤爆のインターリーブは構造的に発生しない)
    if (dialogueId !== undefined) {
      await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [dialogueId]).catch(
        (cleanupErr: unknown) => {
          logger.error('回答送信失敗後の対話レコード削除に失敗しました', cleanupErr, { dialogueId });
        },
      );
    }
    await query(
      pool,
      `UPDATE ops.escalations
       SET status = 'open', resolution = NULL, resolution_type = NULL, resolved_by = NULL, resolved_at = NULL
       WHERE escalation_id = $1 AND status = 'resolved'`,
      [escalation.escalation_id],
    ).catch((rollbackErr: unknown) => {
      logger.error('回答送信失敗後のエスカレーション巻き戻しに失敗しました(resolved のまま未送達の可能性)', rollbackErr, {
        escalationId: escalation.escalation_id,
      });
    });
    logger.error('エスカレーション回答の記録・DM 送信に失敗しました(open へ戻したため再操作できます)', sendErr, {
      escalationId: escalation.escalation_id,
      userId: escalation.related_user_id,
    });
    return { sent: 0, skipped: 0, failed: 1 };
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
 * 還流のみ失敗した場合は sent=1(裁定の記録成功)+failed=1(還流失敗)を返し、
 * ダッシュボード側が「記録は成功・還流のみ失敗」をフラッシュで出し分けられるようにする。
 */
async function recordRuling(
  pool: pg.Pool,
  escalation: EscalationRow,
  textParam: string | undefined,
  operatorUserId: string,
): Promise<JobSummary> {
  const text = requireTextParam(textParam, 'text', RESOLUTION_TEXT_MAX_LENGTH);
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
    return { sent: 1, skipped: 0, failed: 1 };
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
      : requireTextParam(textParam, 'text', RESOLUTION_TEXT_MAX_LENGTH);
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
  // 還流対象は裁定のみ(admin_message / no_action の解決メモをナレッジ化しない)。
  // 判定は shared の共通述語を使う(Chat・dashboard と条件を分散させない — ADR-18)
  if (!isRefluxableResolutionType(escalation.resolution_type)) {
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
