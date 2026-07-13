import { ERROR_CODES, escalationReasonLabel, optionalEnv, query } from '@ai-manager/shared';
import type pg from 'pg';
import { badge, responsiveTable, section, statusBadge } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { invalidInput, requireNumericId, requireText } from '../../admin/form.js';
import { triggerBatchJob } from './batch-trigger.js';
import { adminTabs, csrfField, flashCount, flashMessages, type AdminPageContext } from './common.js';

/**
 * エスカレーション管理(要件 v0.12 §3): 未対応エスカレーションの一覧と解決アクション
 * (メンバーへの回答送信・裁定の記録・回答不要)、および裁定のナレッジ還流の再試行。
 *
 * 実行主体は batch の escalation-action ジョブ(状況確認・今すぐ同期と同じ OIDC 起動パターン)。
 * DB 書込・Chat 送信・ナレッジ還流はすべて batch へ委譲し、dashboard には権限を持たせない。
 * そのため本ページは閲覧用プール(ai_manager_dashboard_ro — ops.escalations / ops.users の
 * SELECT のみ)で完結する(v0.12 §3)。
 */

const PATH = '/admin/escalations';
/** 応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ(checkin と同じ)。 */
const ESCALATION_WAIT_MS = 45_000;
/** context・resolution の一覧表示で折りたたむ長さの閾値。 */
const FOLD_THRESHOLD = 80;

/** 解決アクション(batch の escalation-action ジョブとの契約 — v0.12 §3)。 */
const ESCALATION_ACTIONS = {
  answer: { label: 'メンバーへの回答送信', successParam: 'answered' },
  ruling: { label: '裁定の記録', successParam: 'ruled' },
  no_action: { label: '回答不要の解決', successParam: 'no_action_done' },
  reflux: { label: 'ナレッジ還流の再試行', successParam: 'refluxed' },
} as const;

type EscalationAction = keyof typeof ESCALATION_ACTIONS;

function isEscalationAction(value: string | null): value is EscalationAction {
  return value !== null && Object.hasOwn(ESCALATION_ACTIONS, value);
}

/** 解決種別のラベル。NULL は v0.12 以前の Chat 裁定フローによる解決(=裁定)として扱う。 */
function resolutionTypeLabel(type: string | null): string {
  if (type === null || type === 'ruling') return '裁定(ナレッジ還流)';
  if (type === 'admin_message') return 'メンバーへ回答';
  if (type === 'no_action') return '回答不要';
  return type;
}

interface EscalationRow {
  escalation_id: string;
  reason: string;
  context: string;
  status: string;
  resolution: string | null;
  resolution_type: string | null;
  knowledge_reflected: boolean;
  related_user_id: string | null;
  related_user_name: string | null;
  created: string;
  resolved: string | null;
}

/** 一覧の共通 SELECT 句(open / resolved で WHERE と並び順のみ変える)。 */
const ESCALATION_SELECT = `SELECT e.escalation_id::text AS escalation_id, e.reason, e.context, e.status,
       e.resolution, e.resolution_type, e.knowledge_reflected,
       e.related_user_id, u.display_name AS related_user_name,
       to_char(e.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS created,
       to_char(e.resolved_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS resolved
  FROM ops.escalations e
  LEFT JOIN ops.users u ON u.user_id = e.related_user_id`;

/** 操作結果・失敗のフラッシュ表示(PRG: 再読み込みで再実行しないよう query で受け渡す)。 */
const ESCALATION_SUCCESS_MESSAGES: Record<string, string> = {
  answered: 'メンバーへ回答を送信し、解決として記録しました',
  ruled: '裁定を記録しました。判断基準ナレッジへ還流され、今後の回答に反映されます',
  no_action_done: '回答不要として解決しました',
  refluxed: 'ナレッジ還流を再試行しました',
};

const ESCALATION_ERROR_MESSAGES: Record<string, string> = {
  request:
    'エスカレーション操作の起動に失敗しました。batch サービスの状態とログ(AIM-6009)を確認してください',
  timeout:
    '応答待ちがタイムアウトしました。処理はバックグラウンドで継続している可能性があるため、しばらくしてからこのページを再読み込みして状態を確認してください',
};

function escalationFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  for (const [param, message] of Object.entries(ESCALATION_SUCCESS_MESSAGES)) {
    if (params.get(param) !== '1') continue;
    // JobSummary の failed/skipped を反映する(起動は成功しても処理が失敗・スキップされ得る)
    if (flashCount(params, 'failed') !== '0') {
      return raw(
        `<div class="alert error">操作は受理されましたが処理に失敗しました。batch のログ(AIM-6009)を確認してください</div>`,
      );
    }
    if (flashCount(params, 'sent') === '0' && flashCount(params, 'skipped') !== '0') {
      return raw(
        `<div class="alert ok">対象は処理済みのためスキップされました(別の管理者が既に解決した可能性があります)</div>`,
      );
    }
    return raw(`<div class="alert ok">${h(message)}</div>`);
  }
  const errorKey = params.get('escalation_error');
  // own-property チェック: 継承プロパティ名を誤ってメッセージ扱いしない(checkin と同旨)
  const message =
    errorKey !== null && Object.hasOwn(ESCALATION_ERROR_MESSAGES, errorKey)
      ? ESCALATION_ERROR_MESSAGES[errorKey]
      : undefined;
  if (message !== undefined) return raw(`<div class="alert error">${h(message)}</div>`);
  return raw('');
}

/** 長文(状況・解決内容)の折りたたみ表示。改行は保持し、HTML はエスケープする。 */
function foldedText(text: string): Raw {
  if (text.length <= FOLD_THRESHOLD) return raw(`<span class="pre-wrap">${h(text)}</span>`);
  return raw(
    `<details class="fold"><summary>${h(text.slice(0, FOLD_THRESHOLD))}…</summary><div class="pre-wrap">${h(text)}</div></details>`,
  );
}

/** 解決内容セル(解決種別ラベル+裁定・回答の本文)。 */
function resolutionCell(row: EscalationRow): Raw {
  if (row.status !== 'resolved') return raw('—');
  const label = badge(resolutionTypeLabel(row.resolution_type), 'muted');
  const body =
    row.resolution === null || row.resolution === '' ? raw('') : foldedText(row.resolution);
  return raw(`${label.html}${body.html === '' ? '' : `<div>${body.html}</div>`}`);
}

export async function renderAdminEscalations(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  // 未対応は全件を古い順(放置の防止)、解決済みは直近30日を新しい順で表示する(v0.12 §3)
  const open = await query<EscalationRow>(
    pool,
    `${ESCALATION_SELECT}
     WHERE e.status = 'open'
     ORDER BY e.created_at`,
  );
  const resolved = await query<EscalationRow>(
    pool,
    `${ESCALATION_SELECT}
     WHERE e.status = 'resolved' AND e.resolved_at > now() - INTERVAL '30 days'
     ORDER BY e.resolved_at DESC`,
  );

  const batchUrl = optionalEnv('BATCH_URL', '');

  const listColumns = [
    { key: 'id', label: 'ID' },
    { key: 'created', label: '発生日時' },
    { key: 'reason', label: '理由' },
    { key: 'member', label: '対象メンバー' },
    { key: 'context', label: '状況' },
    { key: 'state', label: '状態' },
    { key: 'resolution', label: '解決内容' },
    { key: 'ops', label: '操作' },
  ];

  const listRow = (row: EscalationRow, ops: Raw): Record<string, Raw | string> => ({
    id: `#${row.escalation_id}`,
    created: row.created,
    reason: escalationReasonLabel(row.reason),
    member: row.related_user_name ?? '—',
    context: foldedText(row.context),
    state: statusBadge(row.status),
    resolution: resolutionCell(row),
    ops,
  });

  // BATCH_URL 未設定時はアクションカード自体を出さないため、行き先のないリンクも出さない
  const openTable = responsiveTable(
    listColumns,
    open.rows.map((row) =>
      listRow(
        row,
        batchUrl === ''
          ? raw('—')
          : raw(`<a href="#escalation-${h(row.escalation_id)}">対応する</a>`),
      ),
    ),
    { emptyText: '未対応のエスカレーションはありません' },
  );

  // 裁定(ruling / NULL=旧データの裁定)で還流未了の行のみ再試行できる(v0.12 §3)
  const refluxForm = (row: EscalationRow): Raw => {
    const eligible =
      row.status === 'resolved' &&
      !row.knowledge_reflected &&
      (row.resolution_type === 'ruling' || row.resolution_type === null);
    if (!eligible || batchUrl === '') return raw('—');
    return raw(`<form method="post" action="${PATH}" class="inline-form"
      onsubmit="return confirm('この裁定のナレッジ還流を再試行しますか?')">
      ${csrfField(ctx).html}
      <input type="hidden" name="action" value="reflux">
      <input type="hidden" name="escalation_id" value="${h(row.escalation_id)}">
      <button class="btn" type="submit">ナレッジ還流を再試行</button>
    </form>`);
  };

  const resolvedTable = responsiveTable(
    listColumns,
    resolved.rows.map((row) => listRow(row, refluxForm(row))),
    { emptyText: '直近30日の解決済みエスカレーションはありません' },
  );

  // BATCH_URL 未設定時はフォームを出さず案内のみ(グレースフルデグラデーション。checkin と同じ)
  const batchNote =
    batchUrl === '' && (open.rows.length > 0 || resolved.rows.length > 0)
      ? html`<p class="form-help">
          BATCH_URL が未設定のため解決操作は表示されません(デプロイ時に batch サービスの URL が自動配線されます。デプロイログの警告を確認してください)。
        </p>`
      : html``;

  // 未対応1件ごとの解決アクションカード(textarea は独立行 — v0.11 §5 の規約)。
  // PRG のアンカー #escalation-{id} でこのカードへ戻る
  const actionCard = (row: EscalationRow): Raw => {
    const answerForm =
      row.related_user_id === null
        ? html`<p class="form-help">
            対象メンバーが記録されていないエスカレーションのため、回答の送信はできません(裁定の記録または回答不要で解決してください)。
          </p>`
        : html`<form method="post" action="${PATH}" class="form" style="margin-top:14px">
            ${csrfField(ctx)}
            <input type="hidden" name="action" value="answer">
            <input type="hidden" name="escalation_id" value="${row.escalation_id}">
            <label class="field">メンバーへの回答(1000字以内)
              <textarea name="text" required maxlength="1000" rows="5"
                        placeholder="${row.related_user_name ?? ''} さんへ AI マネージャー経由で届く回答"></textarea>
            </label>
            <p class="form-help">回答は本人の DM へ届き、このエスカレーションは解決として記録されます</p>
            <button class="btn" type="submit">メンバーへ回答を送信して解決</button>
          </form>`;
    const rulingForm = html`<form method="post" action="${PATH}" class="form" style="margin-top:14px">
      ${csrfField(ctx)}
      <input type="hidden" name="action" value="ruling">
      <input type="hidden" name="escalation_id" value="${row.escalation_id}">
      <label class="field">AIマネージャーへのフィードバック=裁定(1000字以内)
        <textarea name="text" required maxlength="1000" rows="5"
                  placeholder="この状況での判断とその理由"></textarea>
      </label>
      <p class="form-help">判断基準ナレッジへ還流され、今後の回答に反映されます</p>
      <button class="btn" type="submit">AIマネージャーへフィードバック(裁定を記録)</button>
    </form>`;
    const noActionForm = html`<form method="post" action="${PATH}" class="inline-form" style="margin-top:14px"
          onsubmit="return confirm('このエスカレーションを回答不要として解決しますか?')">
      ${csrfField(ctx)}
      <input type="hidden" name="action" value="no_action">
      <input type="hidden" name="escalation_id" value="${row.escalation_id}">
      <button class="btn secondary" type="submit">回答不要として解決</button>
    </form>`;
    return html`<div class="card" id="escalation-${row.escalation_id}" style="margin-top:14px">
      <h3 style="margin-top:0">#${row.escalation_id} ${escalationReasonLabel(row.reason)}(${row.created}) — ${row.related_user_name ?? '対象メンバーなし'}</h3>
      <div class="pre-wrap">${row.context}</div>
      ${answerForm}
      ${rulingForm}
      ${noActionForm}
    </div>`;
  };

  const actionCards =
    batchUrl === '' || open.rows.length === 0
      ? html``
      : section(
          '解決アクション',
          html`${open.rows.map((row) => actionCard(row))}`,
          '実行はいずれも batch 経由です(回答送信=解決の記録+本人 DM への送信/裁定=解決の記録+判断基準ナレッジへの還流/回答不要=解決の記録のみ)',
        );

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx, escalationFlash(ctx))}
    ${section(
      '未対応のエスカレーション',
      html`${openTable}${batchNote}`,
      'AI が管理者判断を求めた事項の一覧です(古い順)。「対応する」から回答送信・裁定の記録・回答不要のいずれかで解決します',
    )}
    ${actionCards}
    ${section(
      '解決済み(直近30日)',
      resolvedTable,
      '裁定で解決しナレッジ還流に失敗した行は「ナレッジ還流を再試行」から還流だけをやり直せます(解決の記録は巻き戻りません)',
      'resolved',
    )}
  `;
}

/**
 * 解決アクションの POST。入力検証と SoT(ops.escalations)での状態確認のみ行い、
 * 実処理は batch の escalation-action ジョブへ委譲する(成功・失敗とも PRG — v0.12 §3)。
 */
export async function handleAdminEscalationsPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');
  if (!isEscalationAction(action)) {
    throw invalidInput('不明な操作です');
  }
  const batchUrl = optionalEnv('BATCH_URL', '');
  if (batchUrl === '') {
    throw invalidInput(
      'BATCH_URL が未設定のためエスカレーションを操作できません(デプロイ時に自動配線されます。デプロイログを確認してください)',
    );
  }
  const escalationId = requireNumericId(form, 'escalation_id', 'エスカレーション');

  // 回答・裁定は本文必須(1000字以内 — v0.12 §3)。他アクションの text は送らない
  let text: string | undefined;
  if (action === 'answer' || action === 'ruling') {
    text = requireText(form, 'text', action === 'answer' ? '回答' : '裁定', 1000);
  }

  // 対象の状態を SoT(ops.escalations)で検証する(hidden input 偽装・解決競合・
  // 対象メンバーなしの回答送信に備える。batch 側でも防御する二段構え)
  if (action === 'reflux') {
    const found = await query(
      pool,
      `SELECT 1 FROM ops.escalations
       WHERE escalation_id = $1 AND status = 'resolved' AND NOT knowledge_reflected
         AND (resolution_type = 'ruling' OR resolution_type IS NULL)`,
      [escalationId],
    );
    if ((found.rowCount ?? 0) === 0) {
      throw invalidInput(
        '還流を再試行できるエスカレーションが見つかりません(還流済みか、裁定以外の解決です)。ページを再読み込みしてやり直してください',
      );
    }
  } else {
    const found = await query<{ related_user_id: string | null }>(
      pool,
      `SELECT related_user_id FROM ops.escalations WHERE escalation_id = $1 AND status = 'open'`,
      [escalationId],
    );
    const row = found.rows[0];
    if (row === undefined) {
      throw invalidInput(
        '未対応のエスカレーションが見つかりません(既に解決済みの可能性があります)。ページを再読み込みしてやり直してください',
      );
    }
    if (action === 'answer' && row.related_user_id === null) {
      throw invalidInput(
        '対象メンバーが記録されていないため回答を送信できません(裁定の記録または回答不要で解決してください)',
      );
    }
  }

  // batch の /jobs/escalation-action を起動する(共通ヘルパー。監査ログもヘルパー側で記録)
  return triggerBatchJob({
    batchUrl,
    jobName: 'escalation-action',
    jobLabel: `エスカレーション操作(${ESCALATION_ACTIONS[action].label})`,
    viewer,
    waitMs: ESCALATION_WAIT_MS,
    errorCode: ERROR_CODES.ESCALATION_ACTION_TRIGGER_FAILED,
    body: {
      escalationId,
      action,
      ...(text === undefined ? {} : { text }),
      operatorUserId: viewer.userId,
    },
    auditAction: `escalation.${action}`,
    auditDetails: { escalationId, action },
    redirectBase: PATH,
    successParam: ESCALATION_ACTIONS[action].successParam,
    errorParam: 'escalation_error',
    // 操作したカード(未対応)/ 解決済み一覧へアンカーで戻る(v0.11 §5)
    redirectAnchor: action === 'reflux' ? 'resolved' : `escalation-${escalationId}`,
  });
}
