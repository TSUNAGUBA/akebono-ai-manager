import { getIdTokenFor, logger } from '@ai-manager/shared';
import { auditLog } from '../../admin/form.js';
import type { Viewer } from '../../render/layout.js';

/**
 * batch ジョブを OIDC ID トークン付きで起動する共通ヘルパー。
 * ナレッジ管理の「今すぐ同期」(knowledge-sync)と状況確認(adhoc-checkin)で共有する。
 * dashboard に Chat 送信権限・rag/ops への書込権限を持たせず、実行主体は常に batch とする。
 */
export interface TriggerBatchJobOptions {
  batchUrl: string;
  /** 起動するジョブ名(/jobs/{jobName})。 */
  jobName: string;
  /** ログ用の表示名(例: 今すぐ同期・状況確認)。 */
  jobLabel: string;
  viewer: Viewer;
  /** 応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ。 */
  waitMs: number;
  /** 起動失敗時のエラーコード(AIM-6007 / AIM-6008)。 */
  errorCode: string;
  /** 指定時は JSON ボディとして送信する(省略時はボディなし)。 */
  body?: Record<string, unknown>;
  /** 監査ログのアクション名(例: knowledge.sync / checkin.send)。 */
  auditAction: string;
  /** 監査ログ・失敗ログに含める対象の詳細(誰に・何を)。 */
  auditDetails: Record<string, unknown>;
  /**
   * PRG リダイレクトの組み立て: `{redirectBase}?{successParam}=1&sent=…` / `?{errorParam}=…`。
   * redirectBase が既にクエリを含む場合(対話ログのフィルタ引き継ぎ等 — v0.12)は & で連結する。
   */
  redirectBase: string;
  successParam: string;
  errorParam: string;
  /**
   * PRG 先の #fragment(v0.11 §5: 操作したセクションへ戻り、最上部へ飛ばされない)。
   * 例: `escalation-3` → `…&failed=0#escalation-3`
   */
  redirectAnchor?: string;
}

/** ジョブを起動し、結果に応じた PRG リダイレクト先を返す(起動失敗も例外にせず PRG する)。 */
export async function triggerBatchJob(opts: TriggerBatchJobOptions): Promise<string> {
  // batch 側の audience 検証(https://{host})と一致させるため末尾スラッシュを正規化する
  const audience = opts.batchUrl.replace(/\/+$/, '');
  const jobUrl = `${audience}/jobs/${opts.jobName}`;
  // PRG 先の組み立て(クエリ連結子とアンカー)。失敗時もアンカーを付け、操作した場所へ戻す
  const sep = opts.redirectBase.includes('?') ? '&' : '?';
  const anchor = opts.redirectAnchor === undefined ? '' : `#${opts.redirectAnchor}`;
  const logContext = {
    errorCode: opts.errorCode,
    operator: opts.viewer.email,
    ...opts.auditDetails,
  };
  let res: Response;
  try {
    const token = await getIdTokenFor(audience);
    res = await fetch(jobUrl, {
      method: 'POST',
      headers:
        opts.body === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.waitMs),
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError') {
      logger.warn(
        `${opts.jobLabel}の応答待ちがタイムアウトしました(処理は継続している可能性があります)`,
        logContext,
      );
      return `${opts.redirectBase}${sep}${opts.errorParam}=timeout${anchor}`;
    }
    logger.error(`${opts.jobLabel}の起動に失敗しました`, err, logContext);
    return `${opts.redirectBase}${sep}${opts.errorParam}=request${anchor}`;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn(`${opts.jobLabel}がエラー応答を返しました`, {
      ...logContext,
      status: res.status,
      body: body.slice(0, 300),
    });
    return `${opts.redirectBase}${sep}${opts.errorParam}=request${anchor}`;
  }
  const summary = (await res.json().catch(() => ({}))) as {
    sent?: unknown;
    skipped?: unknown;
    failed?: unknown;
  };
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  const sent = count(summary.sent);
  const skipped = count(summary.skipped);
  const failed = count(summary.failed);
  // 監査ログ(誰が・何を・いつ。「いつ」はログの time フィールド)
  auditLog(opts.viewer, opts.auditAction, opts.auditDetails, { sent, skipped, failed });
  return `${opts.redirectBase}${sep}${opts.successParam}=1&sent=${sent}&skipped=${skipped}&failed=${failed}${anchor}`;
}
