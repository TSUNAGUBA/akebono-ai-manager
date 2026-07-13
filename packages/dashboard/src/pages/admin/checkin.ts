import { ERROR_CODES, jstDateString, logger, optionalEnv, query } from '@ai-manager/shared';
import type pg from 'pg';
import { badge, responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { invalidInput, requireRef } from '../../admin/form.js';
import { triggerBatchJob } from './batch-trigger.js';
import { adminTabs, csrfField, flashCount, flashMessages, type AdminPageContext } from './common.js';

/**
 * 状況確認(要件 v0.5): active ユーザーの一覧+当日の対話状況を表示し、
 * 管理者の意志で「現在の進捗・状況の問いかけ」を個別/全員へ送信する。
 * 送信対象は問いかけ可(checkin_enabled)のユーザーのみ(v0.8。可否は /admin/users で設定)。
 *
 * 配信の実行主体は batch(朝の問いかけと同一経路)。本ページは「今すぐ同期」と同じ
 * OIDC 呼び出しパターンで batch の /jobs/adhoc-checkin を起動するだけで、
 * dashboard に Chat 送信権限・ops.dialogues への書込権限は持たせない(v0.5 §2)。
 * 一覧は閲覧用ロール(ai_manager_dashboard_ro)の GRANT 範囲
 * (ops.users と集計ビュー ops.v_dialogue_daily_stats)のみで構成する。
 */

const PATH = '/admin/checkin';
/** 送信の応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ(knowledge と同じ)。 */
const CHECKIN_WAIT_MS = 45_000;

interface MemberStatusRow {
  user_id: string;
  display_name: string;
  dm_ready: boolean;
  /** 問いかけ可否(v0.8: ユーザー単位設定。「ユーザー」タブで変更する)。 */
  checkin_enabled: boolean;
  morning_sent: boolean;
  morning_answered: boolean;
  adhoc_sent: boolean;
  adhoc_answered: boolean;
  /** 朝の問いかけ・振り返りに応答中(送信してもスキップされる — 対話の横取り防止)。 */
  responding: boolean;
}

/** 送信結果・失敗のフラッシュ表示(PRG: 再読み込みで再送しないよう query で受け渡す)。 */
const CHECKIN_ERROR_MESSAGES: Record<string, string> = {
  request:
    '状況確認の送信に失敗しました。batch サービスの状態とログ(AIM-6008)を確認してください',
  timeout:
    '送信の応答待ちがタイムアウトしました。送信はバックグラウンドで継続している可能性があるため、しばらくしてからこのページを再読み込みして当日の状況を確認してください',
};

function checkinFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  if (params.get('checkin') === '1') {
    const failed = flashCount(params, 'failed');
    const tone = failed === '0' ? 'ok' : 'error';
    return raw(
      `<div class="alert ${tone}">状況確認を送信しました(送信 ${flashCount(params, 'sent')} 件・スキップ ${flashCount(params, 'skipped')} 件・失敗 ${failed} 件)。問いかけ不可のユーザーは対象外です。DM 未登録、または朝の問いかけ・振り返りに応答中のユーザーはスキップされます</div>`,
    );
  }
  const errorKey = params.get('checkin_error');
  // own-property チェック: 継承プロパティ名を誤ってメッセージ扱いしない(knowledge の syncFlash と同旨)
  const message =
    errorKey !== null && Object.hasOwn(CHECKIN_ERROR_MESSAGES, errorKey)
      ? CHECKIN_ERROR_MESSAGES[errorKey]
      : undefined;
  if (message !== undefined) return raw(`<div class="alert error">${h(message)}</div>`);
  return raw('');
}

/** 当日の朝の問いかけ状況のバッジ。 */
function morningBadge(row: MemberStatusRow): Raw {
  if (!row.morning_sent) return badge('未配信', 'muted');
  return row.morning_answered ? badge('応答済み', 'ok') : badge('未応答', 'warn');
}

/** 当日の状況確認(管理者発火)のバッジ。 */
function adhocBadge(row: MemberStatusRow): Raw {
  if (!row.adhoc_sent) return badge('未送信', 'muted');
  return row.adhoc_answered ? badge('返信あり', 'ok') : badge('返信待ち', 'warn');
}

export async function renderAdminCheckin(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const today = jstDateString();

  // 当日の対話状況・問いかけ可否は表示用の補助情報。db-migrate 未実行(集計ビューの拡張列や
  // ops.users.checkin_enabled 列が未反映)でも一覧と送信は止めず、該当列のみ「不明」に落とす
  // (原則4: グレースフルデグラデーション。フォールバックは新列を参照しない)
  let statsUnavailable = false;
  let members: MemberStatusRow[];
  try {
    const result = await query<MemberStatusRow>(
      pool,
      `SELECT
         u.user_id,
         u.display_name,
         (u.chat_space_id IS NOT NULL) AS dm_ready,
         u.checkin_enabled,
         COALESCE(s.morning_checkin_sent, FALSE) AS morning_sent,
         COALESCE(s.checkin_answered, FALSE) AS morning_answered,
         COALESCE(s.adhoc_checkin_sent, FALSE) AS adhoc_sent,
         COALESCE(s.adhoc_checkin_answered, FALSE) AS adhoc_answered,
         COALESCE(s.responding, FALSE) AS responding
       FROM ops.users u
       LEFT JOIN ops.v_dialogue_daily_stats s
         ON s.user_id = u.user_id AND s.jst_date = $1::date
       WHERE u.active
       ORDER BY u.display_name`,
      [today],
    );
    members = result.rows;
  } catch (err) {
    statsUnavailable = true;
    logger.warn('当日の対話状況の集計に失敗しました(状況列なしで一覧・送信を継続)', {
      errorCode: ERROR_CODES.DASHBOARD_QUERY_FAILED,
      hint: 'db-migrate ジョブの再実行で ops.users.checkin_enabled 列と v_dialogue_daily_stats の拡張列を反映してください',
      cause: err instanceof Error ? err.message : String(err),
    });
    // checkin_enabled(migration 0007)も未適用の可能性があるため参照しない。
    // 可否は「不明」表示とし、送信ボタンは有効のまま倒す(判定の SoT は batch / POST 検証側)
    const fallback = await query<Pick<MemberStatusRow, 'user_id' | 'display_name' | 'dm_ready'>>(
      pool,
      `SELECT u.user_id, u.display_name, (u.chat_space_id IS NOT NULL) AS dm_ready
       FROM ops.users u
       WHERE u.active
       ORDER BY u.display_name`,
    );
    members = fallback.rows.map((row) => ({
      ...row,
      checkin_enabled: true,
      morning_sent: false,
      morning_answered: false,
      adhoc_sent: false,
      adhoc_answered: false,
      responding: false,
    }));
  }

  const batchUrl = optionalEnv('BATCH_URL', '');

  const sendForm = (row: MemberStatusRow): Raw => {
    if (batchUrl === '') return raw('—');
    // 問いかけ不可・DM 未登録・応答中は送信してもスキップされるため、ボタンを無効化して理由を示す。
    // 判定の SoT は batch 側(集計ビュー未反映時はボタン有効のまま batch がスキップする)
    const disabledReason = !row.checkin_enabled
      ? '問いかけ不可に設定されているため送信できません(「ユーザー」タブで変更できます)'
      : !row.dm_ready
        ? 'DM スペース未登録のため送信できません(本人が Chat アプリに一度話しかけると登録されます)'
        : row.responding
          ? '朝の問いかけ・振り返りに応答中のため送信できません(対話の横取り防止。応答の完了後に送信できます)'
          : undefined;
    const disabled = disabledReason === undefined ? '' : ` disabled title="${h(disabledReason)}"`;
    return raw(`<form method="post" action="${PATH}" class="inline-form">
      ${csrfField(ctx).html}
      <input type="hidden" name="action" value="send">
      <input type="hidden" name="user_id" value="${h(row.user_id)}">
      <button class="btn" type="submit"${disabled}>問いかける</button>
    </form>`);
  };

  const table = responsiveTable(
    [
      { key: 'name', label: '名前' },
      { key: 'checkin', label: '問いかけ' },
      { key: 'dm', label: 'DM 登録' },
      { key: 'morning', label: '朝の問いかけ(今日)' },
      { key: 'adhoc', label: '状況確認(今日)' },
      { key: 'ops', label: '操作' },
    ],
    members.map((row) => ({
      name: row.display_name,
      checkin: statsUnavailable
        ? badge('不明', 'muted')
        : row.checkin_enabled
          ? badge('可', 'ok')
          : badge('不可', 'muted'),
      dm: row.dm_ready ? badge('登録済み', 'ok') : badge('未登録', 'warn'),
      morning: statsUnavailable ? badge('不明', 'muted') : morningBadge(row),
      adhoc: statsUnavailable ? badge('不明', 'muted') : adhocBadge(row),
      ops: sendForm(row),
    })),
    { emptyText: 'active なユーザーが登録されていません' },
  );

  const statsNote = statsUnavailable
    ? html`<p class="form-help">当日の対話状況を取得できませんでした(db-migrate ジョブの再実行で集計ビューの拡張を反映してください)</p>`
    : html``;

  // BATCH_URL 未設定時はボタンを出さず案内のみ(グレースフルデグラデーション。knowledge と同じ)
  const sendAllControl =
    batchUrl === ''
      ? html`<p class="form-help">
          BATCH_URL が未設定のため送信ボタンは表示されません(デプロイ時に batch サービスの URL が自動配線されます。デプロイログの警告を確認してください)。
        </p>`
      : html`<div class="btn-row">
          <form method="post" action="${PATH}" class="inline-form"
                onsubmit="return confirm('問いかけ可のユーザー全員に状況確認を送信しますか?')">
            ${csrfField(ctx)}
            <input type="hidden" name="action" value="send_all">
            <button class="btn" type="submit">全員に問いかける</button>
          </form>
          <span class="form-help">対象は「問いかけ可」のユーザーのみ(可否は「ユーザー」タブで設定)。DM 未登録のユーザーと、朝の問いかけ・振り返りに応答中(仮説形成の途中)のユーザーはスキップされ、結果に件数が表示されます</span>
        </div>`;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx)}
    ${checkinFlash(ctx)}
    ${section(
      'メンバーの状況確認',
      html`${table}${statsNote}${sendAllControl}`,
      '問いかけは本人の DM に届き(冒頭に管理者発火であることを明示)、返信は対話として ops.dialogues に記録されます。返信の督促は行いません(返信状況は本ページと概要ページで確認)',
    )}
  `;
}

/** 状況確認の送信(個別/全員)。成功時はリダイレクト先を返す(PRG パターン: 二重送信防止 — v0.5 §2)。 */
export async function handleAdminCheckinPost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');
  if (action !== 'send' && action !== 'send_all') {
    throw invalidInput('不明な操作です');
  }
  const batchUrl = optionalEnv('BATCH_URL', '');
  if (batchUrl === '') {
    throw invalidInput(
      'BATCH_URL が未設定のため状況確認を送信できません(デプロイ時に自動配線されます。デプロイログを確認してください)',
    );
  }

  let userId: string | undefined;
  if (action === 'send') {
    userId = requireRef(form, 'user_id', '対象ユーザー');
    // 対象の実在性と問いかけ可否を SoT(ops.users)で検証する
    // (hidden input 偽装・登録変更・可否変更との競合に備える。batch 側でも防御)
    const found = await query(
      pool,
      `SELECT 1 FROM ops.users WHERE user_id = $1 AND active AND checkin_enabled`,
      [userId],
    );
    if ((found.rowCount ?? 0) === 0) {
      throw invalidInput(
        '対象ユーザーが見つからないか、問いかけ不可に設定されています。ページを再読み込みしてやり直してください',
      );
    }
  }
  // batch の /jobs/adhoc-checkin を起動する(「今すぐ同期」と共通のヘルパー)。
  // 監査ログは v0.5 §2(誰が・誰に・いつ)をヘルパー側で記録する
  return triggerBatchJob({
    batchUrl,
    jobName: 'adhoc-checkin',
    jobLabel: '状況確認',
    viewer,
    waitMs: CHECKIN_WAIT_MS,
    errorCode: ERROR_CODES.CHECKIN_TRIGGER_FAILED,
    body: userId === undefined ? {} : { userId },
    auditAction: 'checkin.send',
    auditDetails: { target: userId ?? 'all-checkin-enabled-users' },
    redirectBase: PATH,
    successParam: 'checkin',
    errorParam: 'checkin_error',
  });
}
