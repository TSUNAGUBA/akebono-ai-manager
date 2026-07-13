import { ERROR_CODES, optionalEnv } from '@ai-manager/shared';
import type pg from 'pg';
import { responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { invalidInput } from '../../admin/form.js';
import { triggerBatchJob } from './batch-trigger.js';
import { adminTabs, csrfField, flashCount, flashMessages, type AdminPageContext } from './common.js';

/**
 * ジョブ手動実行(要件 v0.12 §6): スケジューラで定時実行されるジョブを、
 * 障害復旧・データ更新の前倒し等のために管理者が手動でも起動できるようにする。
 *
 * 起動は状況確認・今すぐ同期と共通の OIDC 呼び出し(triggerBatchJob)で、
 * dashboard 自身は DB 書込を行わない(閲覧用プールで完結する readonly ページ)。
 * いずれのジョブも batch 側が冪等に設計されており、再実行で既存データは巻き戻らない。
 */

const PATH = '/admin/jobs';
/** 応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ(checkin と同じ)。 */
const JOB_WAIT_MS = 45_000;

/**
 * 手動実行できるジョブの whitelist(v0.12 §6)。ここにないジョブ名の POST は拒否する
 * (escalation-action / dialogue-feedback 等のパラメータ必須ジョブを空ボディで
 * 起動させない)。定時はスケジューラ設定(JST)の転記 — 変更時は同時に更新すること。
 */
const MANUAL_JOBS: ReadonlyArray<{
  name: string;
  label: string;
  schedule: string;
  description: string;
}> = [
  {
    name: 'daily-etl',
    label: '集計(日次ETL)',
    schedule: '毎日 02:30',
    description: 'ダッシュボードの集計データを今すぐ更新(当日分を洗い替え・再実行安全)',
  },
  {
    name: 'morning-checkin',
    label: '朝の問いかけ',
    schedule: '平日 08:00',
    description: '未配信のメンバーへ配信(配信済みはスキップ=冪等)',
  },
  {
    name: 'daily-report',
    label: '日報生成',
    schedule: '平日 18:00',
    description: '当日の対話から日報を生成(生成済みは上書きしない)',
  },
  {
    name: 'weekly-summary',
    label: '週次サマリ',
    schedule: '金 17:00',
    description: '管理者向け週次サマリを生成・送信',
  },
  {
    name: 'anomaly-scan',
    label: '異常検知',
    schedule: '平日 09:30',
    description: '停滞・過負荷等の検知(クールダウンあり)',
  },
  {
    name: 'knowledge-sync',
    label: 'ナレッジ同期',
    schedule: '毎日 06:30',
    description: 'Drive → 検索インデックス同期(ナレッジ管理ページの「今すぐ同期」と同じ)',
  },
];

const JOB_ERROR_MESSAGES: Record<string, string> = {
  // batch がジョブ実行後にエラー応答(500)を返すケースも包含するため「起動または実行」と表現する
  request:
    'の起動または実行に失敗しました。batch サービスの状態とログ(AIM-6011)を確認してください',
  timeout:
    'の応答待ちがタイムアウトしました。処理はバックグラウンドで継続している可能性があるため、しばらくしてから結果(ログ・各ページの表示)を確認してください',
};

/** 実行結果・失敗のフラッシュ表示(PRG: 再読み込みでジョブが再実行されないよう query で受け渡す)。 */
function jobsFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  // ジョブ名は whitelist で解決する(クエリ偽装の表示注入を防ぐ)
  const jobLabel = MANUAL_JOBS.find((j) => j.name === params.get('job'))?.label ?? 'ジョブ';
  if (params.get('job_done') === '1') {
    const failed = flashCount(params, 'failed');
    const tone = failed === '0' ? 'ok' : 'error';
    const failedNote = failed === '0' ? '' : '。batch のログ(AIM-6011)を確認してください';
    return raw(
      `<div class="alert ${tone}">「${h(jobLabel)}」を実行しました(処理 ${flashCount(params, 'sent')} 件・スキップ ${flashCount(params, 'skipped')} 件・失敗 ${failed} 件)${failedNote}</div>`,
    );
  }
  const errorKey = params.get('job_error');
  // own-property チェック: 継承プロパティ名を誤ってメッセージ扱いしない(checkin と同旨)
  const message =
    errorKey !== null && Object.hasOwn(JOB_ERROR_MESSAGES, errorKey)
      ? JOB_ERROR_MESSAGES[errorKey]
      : undefined;
  if (message !== undefined) {
    return raw(`<div class="alert error">「${h(jobLabel)}」${h(message)}</div>`);
  }
  return raw('');
}

export async function renderAdminJobs(_pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const batchUrl = optionalEnv('BATCH_URL', '');

  // 二重送信は confirm+PRG で防止する(v0.12 §6)。冪等性の SoT は batch 側の各ジョブ
  const runForm = (job: (typeof MANUAL_JOBS)[number]): Raw => {
    if (batchUrl === '') return raw('—');
    return raw(`<form method="post" action="${PATH}" class="inline-form"
      onsubmit="return confirm('「${h(job.label)}」を今すぐ実行しますか?')">
      ${csrfField(ctx).html}
      <input type="hidden" name="action" value="run">
      <input type="hidden" name="job" value="${h(job.name)}">
      <button class="btn" type="submit">実行</button>
    </form>`);
  };

  const table = responsiveTable(
    [
      { key: 'job', label: 'ジョブ' },
      { key: 'schedule', label: '定時' },
      { key: 'description', label: '説明' },
      { key: 'ops', label: '操作' },
    ],
    MANUAL_JOBS.map((job) => ({
      job: job.label,
      schedule: job.schedule,
      description: job.description,
      ops: runForm(job),
    })),
  );

  // BATCH_URL 未設定時は実行ボタンを出さず案内のみ(グレースフルデグラデーション。checkin と同じ)
  const batchNote =
    batchUrl === ''
      ? html`<p class="form-help">
          BATCH_URL が未設定のため実行ボタンは表示されません(デプロイ時に batch サービスの URL が自動配線されます。デプロイログの警告を確認してください)。定時実行はスケジューラ側の設定で継続します。
        </p>`
      : html``;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx, jobsFlash(ctx))}
    ${section(
      '定時ジョブの手動実行',
      html`${table}${batchNote}`,
      'いずれのジョブも再実行で既存データが巻き戻らないよう設計されています(配信済み・生成済みはスキップ、集計は洗い替え)。定時実行はこのページの操作と関係なく継続します',
    )}
  `;
}

/** ジョブの手動実行(POST)。whitelist 検証後に batch を起動する(成功・失敗とも PRG — v0.12 §6)。 */
export async function handleAdminJobsPost(
  _pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
): Promise<string> {
  const action = form.get('action');
  if (action !== 'run') {
    throw invalidInput('不明な操作です');
  }
  const jobName = (form.get('job') ?? '').trim();
  const job = MANUAL_JOBS.find((j) => j.name === jobName);
  if (job === undefined) {
    throw invalidInput('実行できないジョブが指定されました。ページを再読み込みしてやり直してください');
  }
  const batchUrl = optionalEnv('BATCH_URL', '');
  if (batchUrl === '') {
    throw invalidInput(
      'BATCH_URL が未設定のためジョブを実行できません(デプロイ時に自動配線されます。デプロイログを確認してください)',
    );
  }
  // いずれもボディなしで起動する(既定動作: daily-etl は当日 JST の洗い替え — v0.12 §6)。
  // 監査ログは共通ヘルパー側で記録する(誰が・どのジョブを・いつ)
  const location = await triggerBatchJob({
    batchUrl,
    jobName: job.name,
    jobLabel: job.label,
    viewer,
    waitMs: JOB_WAIT_MS,
    errorCode: ERROR_CODES.JOB_TRIGGER_FAILED,
    auditAction: 'job.trigger',
    auditDetails: { job: job.name },
    redirectBase: PATH,
    successParam: 'job_done',
    errorParam: 'job_error',
  });
  // フラッシュに対象ジョブ名を表示するため PRG 先へ付与する(値は whitelist 検証済み)
  return `${location}&job=${encodeURIComponent(job.name)}`;
}
