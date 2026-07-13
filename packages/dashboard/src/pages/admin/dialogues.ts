import {
  ERROR_CODES,
  FEEDBACK_TEXT_MAX_LENGTH,
  jstDateString,
  optionalEnv,
  query,
} from '@ai-manager/shared';
import type pg from 'pg';
import { badge, responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { invalidInput, isRealDateString, requireNumericId, requireText } from '../../admin/form.js';
import { triggerBatchJob } from './batch-trigger.js';
import { adminTabs, csrfField, flashCount, flashMessages, type AdminPageContext } from './common.js';

/**
 * 対話ログ+フィードバック(要件 v0.12 §7): メンバーと AI の生の対話ログを確認し、
 * AI の誤った回答へ管理者が「正しい回答・指摘」をフィードバックする。
 * フィードバックを受けた AI(batch の dialogue-feedback ジョブ)がお詫びと訂正を本人へ送る。
 *
 * 生の対話ログ(ops.dialogues)・フィードバック(ops.dialogue_feedback)は
 * 管理ロール ai_manager_admin_rw のみ SELECT 可のため、本ページは admin プール必須
 * (「閲覧ロールは生の対話ログを読めない」境界 = 要件 7.5 の維持。未構成時は
 * server.ts が renderAdminUnconfigured の案内を出す)。
 * フィードバックの記録・訂正送信の書込は batch に委譲し、dashboard は書込権限を持たない。
 */

const PATH = '/admin/dialogues';
/** 応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ(checkin と同じ)。 */
const FEEDBACK_WAIT_MS = 45_000;

/** 対話種別の表示ラベル(ops.dialogues.dialogue_type の CHECK 制約と同じ値集合 — v0.12 §7)。 */
const DIALOGUE_TYPE_LABELS: Record<string, string> = {
  morning_checkin: '朝の問いかけ',
  completion_review: '夕の振り返り',
  adhoc_qa: '随時QA',
  task_instruction: 'タスク指示',
  escalation: 'エスカレーション',
  adhoc_checkin: '状況確認',
  feedback_correction: 'フィードバック訂正',
};

function dialogueTypeLabel(type: string): string {
  return DIALOGUE_TYPE_LABELS[type] ?? type;
}

interface DialogueRow {
  dialogue_id: string;
  /** batch 側の対話存在検証(dialogue_id + created_at)へそのまま返すための ISO(UTC)文字列。 */
  created_iso: string;
  created_jst: string;
  user_id: string;
  display_name: string;
  dialogue_type: string;
  turns: unknown;
}

interface FeedbackRow {
  feedback_id: string;
  dialogue_id: string;
  status: string;
  feedback: string;
  /** rag への還流済みフラグ。delivered かつ未還流は「ナレッジ再還流」で回復できる(原則6)。 */
  knowledge_reflected: boolean;
  created_jst: string;
  delivered_jst: string | null;
}

interface UserOption {
  user_id: string;
  display_name: string;
}

/** 送信結果・失敗のフラッシュ表示(PRG: 再読み込みで再送しないよう query で受け渡す)。 */
const FEEDBACK_SUCCESS_MESSAGES: Record<string, string> = {
  feedback: 'フィードバックを記録しました。AI がお詫びと訂正を本人へ送ります',
  feedback_resent: '訂正メッセージを再送しました',
  feedback_refluxed: 'フィードバックをナレッジへ再還流しました。以後の回答に反映されます',
};

const FEEDBACK_ERROR_MESSAGES: Record<string, string> = {
  // batch がジョブ実行後にエラー応答(500)を返すケースも包含するため「起動または実行」と表現する
  request:
    'フィードバック処理の起動または実行に失敗しました。batch サービスの状態とログ(AIM-6010)を確認してください',
  timeout:
    '応答待ちがタイムアウトしました。処理はバックグラウンドで継続している可能性があるため、しばらくしてからこのページを再読み込みして送信状態を確認してください',
};

function feedbackFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  for (const [param, message] of Object.entries(FEEDBACK_SUCCESS_MESSAGES)) {
    if (params.get(param) !== '1') continue;
    // JobSummary の failed を反映する(起動は成功しても訂正送信・還流が失敗し得る。
    // 訂正未送達は「再送」、送達済みで還流未了は「ナレッジ再還流」から再試行できる)
    if (flashCount(params, 'failed') !== '0') {
      return raw(
        `<div class="alert error">フィードバックの処理に失敗しました。batch のログ(AIM-6010)を確認してください(「訂正送信待ち」は「再送」、「未還流」は「ナレッジ再還流」から再試行できます)</div>`,
      );
    }
    return raw(`<div class="alert ok">${h(message)}</div>`);
  }
  const errorKey = params.get('feedback_error');
  // own-property チェック: 継承プロパティ名を誤ってメッセージ扱いしない(checkin と同旨)
  const message =
    errorKey !== null && Object.hasOwn(FEEDBACK_ERROR_MESSAGES, errorKey)
      ? FEEDBACK_ERROR_MESSAGES[errorKey]
      : undefined;
  if (message !== undefined) return raw(`<div class="alert error">${h(message)}</div>`);
  return raw('');
}

/** turns(JSONB)のターン数。想定外の形(配列以外)は 0 に落とす。 */
function turnCount(turns: unknown): number {
  return Array.isArray(turns) ? turns.length : 0;
}

/**
 * turns の展開表示。role=user は「本人」、role=ai は「AI」。
 * content はユーザー・AI の生テキストのため必ず HTML エスケープし、改行は保持する(v0.12 §7)。
 */
function renderTurns(turns: unknown): Raw {
  if (!Array.isArray(turns) || turns.length === 0) {
    return raw(`<p class="form-help">ターンが記録されていません</p>`);
  }
  const items = turns
    .map((turn) => {
      const t = turn as { role?: unknown; content?: unknown };
      const role = t.role === 'ai' ? 'AI' : t.role === 'user' ? '本人' : String(t.role ?? '不明');
      const content = typeof t.content === 'string' ? t.content : JSON.stringify(t.content ?? '');
      return `<div class="turn"><span class="turn-role">${h(role)}</span><div class="pre-wrap">${h(content)}</div></div>`;
    })
    .join('');
  return raw(`<div class="turns">${items}</div>`);
}

export async function renderAdminDialogues(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  // フィルタ(GET クエリ): 日付は当日 JST が既定。不正な日付は既定へ落とす(表示専用のため 400 にしない)
  const requestedDate = ctx.url.searchParams.get('date');
  const date =
    requestedDate !== null && isRealDateString(requestedDate) ? requestedDate : jstDateString();
  const requestedUser = (ctx.url.searchParams.get('user') ?? '').trim();
  const userId = requestedUser === '' || requestedUser.length > 64 ? null : requestedUser;

  // ユーザー選択肢(admin_rw の列単位 GRANT の範囲: user_id / display_name / active)
  const users = await query<UserOption>(
    pool,
    `SELECT user_id, display_name FROM ops.users WHERE active ORDER BY display_name`,
  );

  // JST 日付の範囲条件は batch(daily-report 等)と同じ書き方でインデックスに乗せる。
  // created_iso は batch 側の対話存在検証へそのまま hidden 送信する ISO(UTC)文字列
  const dialogues = await query<DialogueRow>(
    pool,
    `SELECT d.dialogue_id::text AS dialogue_id,
            to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso,
            to_char(d.created_at AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') AS created_jst,
            d.user_id, u.display_name, d.dialogue_type, d.turns
     FROM ops.dialogues d
     JOIN ops.users u ON u.user_id = d.user_id
     WHERE d.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND d.created_at <  (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
       AND ($2::text IS NULL OR d.user_id = $2)
     ORDER BY d.created_at`,
    [date, userId],
  );

  // 表示中の対話に紐づく既存フィードバック(pending=再送可能 / delivered=送信済み)
  const feedbackByDialogue = new Map<string, FeedbackRow[]>();
  if (dialogues.rows.length > 0) {
    const feedback = await query<FeedbackRow>(
      pool,
      `SELECT feedback_id::text AS feedback_id, dialogue_id::text AS dialogue_id, status, feedback,
              knowledge_reflected,
              to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS created_jst,
              to_char(delivered_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS delivered_jst
       FROM ops.dialogue_feedback
       WHERE dialogue_id = ANY($1::bigint[])
       ORDER BY created_at`,
      [dialogues.rows.map((d) => d.dialogue_id)],
    );
    for (const row of feedback.rows) {
      const list = feedbackByDialogue.get(row.dialogue_id) ?? [];
      list.push(row);
      feedbackByDialogue.set(row.dialogue_id, list);
    }
  }

  const batchUrl = optionalEnv('BATCH_URL', '');

  // ── フィルタフォーム(GET のため CSRF 不要)──
  const userOptions =
    `<option value="">全ユーザー</option>` +
    users.rows
      .map(
        (u) =>
          `<option value="${h(u.user_id)}"${u.user_id === userId ? ' selected' : ''}>${h(u.display_name)}</option>`,
      )
      .join('');
  const filterForm = html`<form method="get" action="${PATH}" class="card form">
    <div class="form-grid">
      <label class="field">ユーザー
        ${raw(`<select name="user">${userOptions}</select>`)}
      </label>
      <label class="field">日付
        <input type="date" name="date" value="${date}">
      </label>
    </div>
    <button class="btn" type="submit">表示する</button>
  </form>`;

  // ── 一覧(モバイルはカード表示 — 原則8)──
  const table = responsiveTable(
    [
      { key: 'time', label: '時刻' },
      { key: 'name', label: 'ユーザー' },
      { key: 'type', label: '種別' },
      { key: 'turns', label: 'ターン数', numeric: true },
      { key: 'content', label: '内容' },
      { key: 'ops', label: '操作' },
    ],
    dialogues.rows.map((d) => ({
      time: d.created_jst,
      name: d.display_name,
      type: dialogueTypeLabel(d.dialogue_type),
      turns: turnCount(d.turns),
      content: raw(
        `<details class="fold"><summary>対話を表示</summary>${renderTurns(d.turns).html}</details>`,
      ),
      ops: raw(`<a href="#dialogue-${h(d.dialogue_id)}">フィードバック</a>`),
    })),
    { emptyText: 'この日の対話はありません(日付・ユーザーのフィルタを変更してください)' },
  );

  // ── フィードバックカード(対話ごと。PRG のアンカー #dialogue-{id} でここへ戻る)──
  // フィルタ引き継ぎ用の hidden(再送・再還流の各フォームで共通)
  const filterFields = html`<input type="hidden" name="filter_user" value="${requestedUser}">
    <input type="hidden" name="filter_date" value="${date}">`;

  const feedbackStatus = (fb: FeedbackRow): Raw => {
    // 送達済みで還流未了の行のみ「ナレッジ再還流」で回復できる(手動回復パス — 原則6)
    const refluxForm =
      fb.status === 'delivered' && !fb.knowledge_reflected && batchUrl !== ''
        ? html`<form method="post" action="${PATH}" class="inline-form" style="margin-left:10px"
              onsubmit="return confirm('このフィードバックのナレッジ還流を再試行しますか?')">
            ${csrfField(ctx)}
            <input type="hidden" name="action" value="reflux">
            <input type="hidden" name="feedback_id" value="${fb.feedback_id}">
            ${filterFields}
            <button class="btn secondary" type="submit">ナレッジ再還流</button>
          </form>`
        : html``;
    const state =
      fb.status === 'delivered'
        ? html`${badge('訂正送信済み', 'ok')} ${
            fb.knowledge_reflected ? badge('還流済み', 'ok') : badge('未還流', 'warn')
          } 送信日時: ${fb.delivered_jst ?? '—'}${refluxForm}`
        : html`${badge('訂正送信待ち', 'warn')} ${
            fb.knowledge_reflected ? badge('還流済み', 'ok') : badge('未還流', 'muted')
          } 記録日時: ${fb.created_jst}${
            batchUrl === ''
              ? html``
              : html`<form method="post" action="${PATH}" class="inline-form" style="margin-left:10px"
                    onsubmit="return confirm('この訂正メッセージを再送しますか?')">
                  ${csrfField(ctx)}
                  <input type="hidden" name="action" value="resend">
                  <input type="hidden" name="feedback_id" value="${fb.feedback_id}">
                  ${filterFields}
                  <button class="btn secondary" type="submit">再送</button>
                </form>`
          }`;
    return html`<div style="margin-top:10px">
      ${state}
      <div class="pre-wrap" style="margin-top:4px">${fb.feedback}</div>
    </div>`;
  };

  const feedbackCard = (d: DialogueRow): Raw => {
    const existing = feedbackByDialogue.get(d.dialogue_id) ?? [];
    const form =
      batchUrl === ''
        ? html`<p class="form-help">
            BATCH_URL が未設定のためフィードバックは送信できません(デプロイ時に batch サービスの URL が自動配線されます。デプロイログの警告を確認してください)。
          </p>`
        : html`<form method="post" action="${PATH}" class="form" style="margin-top:14px"
              onsubmit="return confirm('このフィードバックを送信しますか?(AI がお詫びと訂正を本人へ送ります)')">
            ${csrfField(ctx)}
            <input type="hidden" name="action" value="feedback">
            <input type="hidden" name="dialogue_id" value="${d.dialogue_id}">
            <input type="hidden" name="dialogue_created_at" value="${d.created_iso}">
            ${filterFields}
            <label class="field">正しい回答・指摘(AI がお詫びと訂正を本人へ送ります)(${FEEDBACK_TEXT_MAX_LENGTH}字以内)
              <textarea name="feedback" required maxlength="${FEEDBACK_TEXT_MAX_LENGTH}" rows="5"
                        placeholder="AI の回答のどこが誤りで、正しくはどうかを具体的に"></textarea>
            </label>
            <button class="btn" type="submit">フィードバックを送信</button>
          </form>`;
    return html`<div class="card" id="dialogue-${d.dialogue_id}" style="margin-top:14px">
      <h3 style="margin-top:0">${d.created_jst} ${d.display_name} — ${dialogueTypeLabel(d.dialogue_type)}(${turnCount(d.turns)}ターン)</h3>
      <details class="fold"><summary>対話を表示</summary>${renderTurns(d.turns)}</details>
      ${existing.map((fb) => feedbackStatus(fb))}
      ${form}
    </div>`;
  };

  const feedbackSection =
    dialogues.rows.length === 0
      ? html``
      : section(
          'フィードバック(お詫びと訂正の送信)',
          html`${dialogues.rows.map((d) => feedbackCard(d))}`,
          'フィードバックの記録・訂正メッセージの送信・ナレッジへの還流は batch が行います。訂正の送信に失敗した場合は「再送」、還流のみ失敗した場合は「ナレッジ再還流」から再試行できます(送信済みの訂正は再送されません — 冪等)',
        );

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx, feedbackFlash(ctx))}
    ${section(
      '対話ログ',
      html`${filterForm}${table}`,
      '生の対話ログは管理者のみ閲覧できます(メンバーの振り返り資産の保護 — 要件 7.5)。日付は JST、既定は当日です',
    )}
    ${feedbackSection}
  `;
}

/** PRG 先へフィルタ(ユーザー・日付)を引き継ぐ(操作した対話が再表示されるように)。 */
function redirectBaseWithFilters(form: URLSearchParams): string {
  const params = new URLSearchParams();
  const user = (form.get('filter_user') ?? '').trim();
  if (user !== '' && user.length <= 64) params.set('user', user);
  const date = (form.get('filter_date') ?? '').trim();
  if (isRealDateString(date)) params.set('date', date);
  const qs = params.toString();
  return qs === '' ? PATH : `${PATH}?${qs}`;
}

/**
 * フィードバックの送信・再送の POST。入力検証のみ行い、記録・訂正送信は
 * batch の dialogue-feedback ジョブへ委譲する(成功・失敗とも PRG — v0.12 §7)。
 */
export async function handleAdminDialoguesPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');
  if (action !== 'feedback' && action !== 'resend' && action !== 'reflux') {
    throw invalidInput('不明な操作です');
  }
  const batchUrl = optionalEnv('BATCH_URL', '');
  if (batchUrl === '') {
    throw invalidInput(
      'BATCH_URL が未設定のためフィードバックを送信できません(デプロイ時に自動配線されます。デプロイログを確認してください)',
    );
  }
  const redirectBase = redirectBaseWithFilters(form);

  if (action === 'feedback') {
    const dialogueId = requireNumericId(form, 'dialogue_id', '対話');
    const dialogueCreatedAt = requireText(form, 'dialogue_created_at', '対話日時', 64);
    // 形式のみ検証する。hidden の dialogueCreatedAt を改ざんされても、batch 側の
    // 対話存在検証(dialogue_id + created_at の一致)で弾かれる(v0.12 §7)
    if (Number.isNaN(new Date(dialogueCreatedAt).getTime())) {
      throw invalidInput('対話日時の形式が不正です。ページを再読み込みしてやり直してください');
    }
    // 上限は batch との契約定数 FEEDBACK_TEXT_MAX_LENGTH(片側変更によるドリフト防止)
    const feedback = requireText(form, 'feedback', 'フィードバック', FEEDBACK_TEXT_MAX_LENGTH);
    // batch の /jobs/dialogue-feedback を起動する(共通ヘルパー。監査ログもヘルパー側で記録)
    return triggerBatchJob({
      batchUrl,
      jobName: 'dialogue-feedback',
      jobLabel: '対話フィードバック',
      viewer,
      waitMs: FEEDBACK_WAIT_MS,
      errorCode: ERROR_CODES.FEEDBACK_TRIGGER_FAILED,
      body: { dialogueId, dialogueCreatedAt, feedback, operatorUserId: viewer.userId },
      auditAction: 'dialogue.feedback',
      auditDetails: { dialogueId },
      redirectBase,
      successParam: 'feedback',
      errorParam: 'feedback_error',
      redirectAnchor: `dialogue-${dialogueId}`,
    });
  }

  const feedbackId = requireNumericId(form, 'feedback_id', 'フィードバック');

  if (action === 'resend') {
    // 記録済みフィードバック(pending)の訂正メッセージ再送。
    // 再送対象を SoT(ops.dialogue_feedback)で検証する(delivered の二重送信を防ぐ — 原則2。
    // batch 側でも防御する二段構え)。dialogue_id は PRG のアンカーに使う
    const found = await query<{ dialogue_id: string }>(
      pool,
      `SELECT dialogue_id::text AS dialogue_id
       FROM ops.dialogue_feedback
       WHERE feedback_id = $1 AND status = 'pending'`,
      [feedbackId],
    );
    const row = found.rows[0];
    if (row === undefined) {
      throw invalidInput(
        '再送できるフィードバックが見つかりません(既に送信済みの可能性があります)。ページを再読み込みしてやり直してください',
      );
    }
    return triggerBatchJob({
      batchUrl,
      jobName: 'dialogue-feedback',
      jobLabel: '対話フィードバック(再送)',
      viewer,
      waitMs: FEEDBACK_WAIT_MS,
      errorCode: ERROR_CODES.FEEDBACK_TRIGGER_FAILED,
      body: { feedbackId, operatorUserId: viewer.userId },
      auditAction: 'dialogue.feedback_resend',
      auditDetails: { feedbackId },
      redirectBase,
      successParam: 'feedback_resent',
      errorParam: 'feedback_error',
      redirectAnchor: `dialogue-${row.dialogue_id}`,
    });
  }

  // action === 'reflux': 送達済み(delivered)で還流未了のフィードバックの再還流(訂正は再送しない)。
  const found = await query<{ dialogue_id: string }>(
    pool,
    `SELECT dialogue_id::text AS dialogue_id
     FROM ops.dialogue_feedback
     WHERE feedback_id = $1 AND status = 'delivered' AND NOT knowledge_reflected`,
    [feedbackId],
  );
  const row = found.rows[0];
  if (row === undefined) {
    throw invalidInput(
      '再還流できるフィードバックが見つかりません(還流済みか、訂正が未送達です)。ページを再読み込みしてやり直してください',
    );
  }
  return triggerBatchJob({
    batchUrl,
    jobName: 'dialogue-feedback',
    jobLabel: '対話フィードバック(ナレッジ再還流)',
    viewer,
    waitMs: FEEDBACK_WAIT_MS,
    errorCode: ERROR_CODES.FEEDBACK_TRIGGER_FAILED,
    // refluxOnly は batch との契約(還流のみ再試行し、訂正メッセージは再送しない)
    body: { feedbackId, refluxOnly: 'true', operatorUserId: viewer.userId },
    auditAction: 'dialogue.feedback_reflux',
    auditDetails: { feedbackId },
    redirectBase,
    successParam: 'feedback_refluxed',
    errorParam: 'feedback_error',
    redirectAnchor: `dialogue-${row.dialogue_id}`,
  });
}
