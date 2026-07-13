import {
  ensureSubfolder,
  ERROR_CODES,
  jstDateTimeString,
  listFilesRecursive,
  logger,
  optionalEnv,
  PDF_MIME,
  query,
  trashFile,
  upsertFile,
  upsertTextFile,
  type DriveFile,
  type DriveFolderListing,
  type MultipartFile,
} from '@ai-manager/shared';
import type pg from 'pg';
import { badge, responsiveTable, section } from '../../render/components.js';
import { h, html, raw, type Raw } from '../../render/html.js';
import type { Viewer } from '../../render/layout.js';
import { auditLog, invalidInput, requireRef } from '../../admin/form.js';
import { triggerBatchJob } from './batch-trigger.js';
import { adminTabs, csrfField, flashMessages, type AdminPageContext } from './common.js';

/**
 * ナレッジ管理(要件 v0.4): Drive のナレッジ文書の一覧・投入・上書き・削除と即時同期。
 * SoT は引き続き Drive(本ページは投入経路にすぎない)。保存 → knowledge-sync → rag の
 * 既存データフローは変えず、rag への直接書込は行わない(SoT 分裂の防止: v0.4 §2)。
 */

const PATH = '/admin/knowledge';

/**
 * 投入ファイル名の拡張子規約(.md / .txt / .pdf)。
 * v0.11 でファイル名本体の文字種制限(小文字英数字のみ)は撤廃した — 同期(Drive → rag)は
 * 元々ファイル名の文字種に依存せず、日本語名のファイルもそのまま同期・検索対象になるため。
 * 禁止するのは表示・API 呼び出しを壊し得る文字(制御文字・パス区切り)のみ。
 */
export const KNOWLEDGE_FILE_EXT_PATTERN = /\.(md|txt|pdf)$/;
/** 制御文字・パス区切り(Drive 上の表示や API クエリを壊し得るもののみ禁止)。 */
const FILE_NAME_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f/\\]/;
const FILE_NAME_MAX_LENGTH = 128;
const CONTENT_MAX_BYTES = 200 * 1024;
/** PDF の1ファイル上限(multipart 全体の 4MiB 上限内に収める)。 */
const PDF_MAX_BYTES = 3 * 1024 * 1024;
/** PDF のマジックバイト(%PDF-)。拡張子偽装の取り違えを投入前に検出する。 */
const PDF_MAGIC = Buffer.from('%PDF-');
/** Drive ファイル ID の形式(delete フォームの hidden input 検証用)。 */
const DRIVE_FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
/** 「今すぐ同期」の応答待ち上限。dashboard の Cloud Run タイムアウト(60s)より短く保つ。 */
const SYNC_WAIT_MS = 45_000;
/** ファイルアップロードの1回あたり上限件数(v0.6。リクエスト全体は multipart の 4MiB 上限)。 */
const MAX_UPLOAD_FILES = 10;

/**
 * ファイル名の検証と正規化(v0.11: 日本語等の Unicode 名を許容)。
 * 拡張子がなければ .md を付与し、英大文字は小文字へ寄せる(従来の投入分との
 * 同名上書き互換を保つ)。制御文字・パス区切りを含む名前は AIM-6004。
 */
export function normalizeKnowledgeFileName(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') throw invalidInput('ファイル名を入力してください');
  const withExt = KNOWLEDGE_FILE_EXT_PATTERN.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (withExt.length > FILE_NAME_MAX_LENGTH) {
    throw invalidInput(`ファイル名は拡張子を含め ${FILE_NAME_MAX_LENGTH} 文字以内で入力してください`);
  }
  if (FILE_NAME_FORBIDDEN_CHARS.test(withExt)) {
    throw invalidInput('ファイル名に使用できない文字(制御文字・スラッシュ)が含まれています');
  }
  // 拡張子を除いた本体が空またはドットのみ('.md'・'..md' 等)の無意味な名前は拒否する
  if (/^\.*$/.test(withExt.replace(KNOWLEDGE_FILE_EXT_PATTERN, ''))) {
    throw invalidInput('ファイル名を入力してください(拡張子のみの名前は使えません)');
  }
  return withExt;
}

/**
 * 格納先からフォルダ規約(要件 M1)のパスセグメントを組み立てる。
 *   judgement → judgement/ / domain → domain/{業界ID}/ / customer → customer/{顧客ID}/
 */
export function knowledgeFolderSegments(
  target: string,
  industryId: string | null,
  customerId: string | null,
): string[] {
  if (target === 'judgement') return ['judgement'];
  if (target === 'domain') {
    if (industryId === null) throw invalidInput('業界を選択してください');
    return ['domain', industryId];
  }
  if (target === 'customer') {
    if (customerId === null) throw invalidInput('顧客を選択してください');
    return ['customer', customerId];
  }
  throw invalidInput('格納先が不正です');
}

interface ChunkStat {
  doc_id: string;
  chunk_count: number;
  last_synced: string;
}

interface IndustryOption {
  industry_id: string;
  name: string;
  active: boolean;
}

interface CustomerOption {
  customer_id: string;
  name: string;
}

/** 「今すぐ同期」の結果・失敗のフラッシュ表示(PRG: 再読み込みでジョブが再起動しないよう query で受け渡す)。 */
const SYNC_ERROR_MESSAGES: Record<string, string> = {
  request:
    '同期ジョブの起動に失敗しました。batch サービスの状態とログ(AIM-6007)を確認してください',
  timeout:
    '同期の応答待ちがタイムアウトしました。同期はバックグラウンドで継続している可能性があるため、しばらくしてからこのページを再読み込みして同期状態を確認してください',
};

/** ?failed_names=(JSON 配列)の検証つきパース。不正な値は黙って捨てる(表示注入の防止)。 */
function parseFailedNames(param: string | null): string[] {
  if (param === null) return [];
  try {
    const parsed: unknown = JSON.parse(param);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (n): n is string =>
          typeof n === 'string' &&
          n.length <= FILE_NAME_MAX_LENGTH &&
          KNOWLEDGE_FILE_EXT_PATTERN.test(n) &&
          !FILE_NAME_FORBIDDEN_CHARS.test(n),
      )
      .slice(0, MAX_UPLOAD_FILES);
  } catch {
    return [];
  }
}

/** ファイルアップロードの結果フラッシュ(?uploaded=1&created=…。PRG: 再読み込みで再投入しない)。 */
function uploadFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  if (params.get('uploaded') !== '1') return raw('');
  const count = (name: string): string => {
    const value = params.get(name) ?? '';
    return /^\d{1,6}$/.test(value) ? value : '0';
  };
  const failed = count('failed');
  const tone = failed === '0' ? 'ok' : 'error';
  // 失敗ファイル名は JSON 配列で受け渡す(日本語名対応: v0.11)。表示は h() で
  // エスケープするが、クエリ偽装に備えてファイル名規約(拡張子・長さ・禁止文字)も検証する
  const failedNames = parseFailedNames(params.get('failed_names'));
  const failedNote =
    failedNames.length > 0
      ? `。失敗したファイル: ${failedNames.map((n) => h(n)).join('、')}(ログ AIM-6006 を確認してください)`
      : '';
  return raw(
    `<div class="alert ${tone}">ファイルを投入しました(新規 ${count('created')} 件・上書き ${count('updated')} 件・失敗 ${failed} 件)${failedNote}</div>`,
  );
}

function syncFlash(ctx: AdminPageContext): Raw {
  const params = ctx.url.searchParams;
  if (params.get('synced') === '1') {
    const count = (name: string): string => {
      const value = params.get(name) ?? '';
      return /^\d{1,6}$/.test(value) ? value : '0';
    };
    const failed = count('failed');
    const tone = failed === '0' ? 'ok' : 'error';
    return raw(
      `<div class="alert ${tone}">同期が完了しました(更新 ${count('sent')} 件・変更なし ${count('skipped')} 件・失敗 ${count('failed')} 件)</div>`,
    );
  }
  const errorKey = params.get('sync_error');
  // own-property チェック: 継承プロパティ名を誤ってメッセージ扱いしない(flashMessages と同旨)
  const message =
    errorKey !== null && Object.hasOwn(SYNC_ERROR_MESSAGES, errorKey)
      ? SYNC_ERROR_MESSAGES[errorKey]
      : undefined;
  if (message !== undefined) return raw(`<div class="alert error">${h(message)}</div>`);
  return raw('');
}

/** KNOWLEDGE_DRIVE_FOLDER_ID 未設定時の案内(グレースフルデグラデーション)。 */
function renderKnowledgeUnconfigured(): Raw {
  return html`<div class="card">
    <h2 style="margin-top:0">ナレッジ管理は未構成です</h2>
    <p>
      ナレッジフォルダの環境変数(<strong>KNOWLEDGE_DRIVE_FOLDER_ID</strong>)が
      設定されていないため、ナレッジ管理ページは利用できません。
    </p>
    <p>
      設定手順は <code>docs/operations/deployment-setup.md</code> Step 7-3 / 7-8 を参照してください
      (Drive フォルダのランタイム SA への<strong>編集者</strong>共有と、secret の登録)。
    </p>
    <p class="form-help">マスタ管理・閲覧機能はこれまでどおり利用できます。</p>
  </div>`;
}

export async function renderAdminKnowledge(pool: pg.Pool, ctx: AdminPageContext): Promise<Raw> {
  const folderId = optionalEnv('KNOWLEDGE_DRIVE_FOLDER_ID', '');
  if (folderId === '') {
    return html`
      ${adminTabs(PATH)}
      ${flashMessages(ctx)}
      ${renderKnowledgeUnconfigured()}
    `;
  }

  const industries = await query<IndustryOption>(
    pool,
    `SELECT industry_id, name, active
     FROM ops.industries
     ORDER BY display_order NULLS LAST, industry_id`,
  );
  const customers = await query<CustomerOption>(
    pool,
    `SELECT customer_id, name FROM ops.customers ORDER BY customer_id`,
  );

  // 同期状態(rag のチャンク集計)。表示用の補助情報のため、失敗しても一覧・投入は止めない(原則4)
  let chunkStats = new Map<string, ChunkStat>();
  let statsUnavailable = false;
  try {
    const result = await query<ChunkStat>(
      pool,
      `SELECT doc_id, count(*)::int AS chunk_count,
              to_char(max(updated_at) AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS last_synced
       FROM rag.knowledge_chunks
       GROUP BY doc_id`,
    );
    chunkStats = new Map(result.rows.map((r) => [r.doc_id, r]));
  } catch (err) {
    statsUnavailable = true;
    logger.warn('rag.knowledge_chunks の集計に失敗しました(同期状態なしで表示を継続)', {
      errorCode: ERROR_CODES.DASHBOARD_QUERY_FAILED,
      hint: 'db-migrate ジョブの再実行で ai_manager_admin_rw への GRANT を反映してください',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // Drive の文書一覧。失敗(未共有・フォルダID誤り等)は案内付きのエラー表示に留める(原則4)
  let listing: DriveFolderListing | undefined;
  let listErrorMessage: string | undefined;
  try {
    listing = await listFilesRecursive(folderId);
  } catch (err) {
    logger.error('ナレッジフォルダの一覧取得に失敗しました', err, { path: PATH });
    listErrorMessage =
      'ナレッジフォルダの一覧を取得できませんでした。KNOWLEDGE_DRIVE_FOLDER_ID の値と、フォルダがランタイム SA に共有されているかを確認してください(deployment-setup.md Step 7-3)';
  }
  const files = listing?.files;

  const deleteForm = (f: DriveFile): Raw =>
    raw(`<form method="post" action="${PATH}" class="inline-form"
      onsubmit="return confirm('この文書を Drive のゴミ箱へ移動しますか?(検索からは次回同期で消えます)')">
      ${csrfField(ctx).html}
      <input type="hidden" name="action" value="delete">
      <input type="hidden" name="file_id" value="${h(f.id)}">
      <input type="hidden" name="file_name" value="${h(f.name)}">
      <button class="btn danger" type="submit">削除</button>
    </form>`);

  const syncState = (f: DriveFile): Raw => {
    if (statsUnavailable) return badge('不明', 'muted');
    const stat = chunkStats.get(f.id);
    if (stat === undefined) return badge('未同期', 'warn');
    return badge(`同期済み(${stat.chunk_count}チャンク)`, 'ok');
  };

  /** Drive の modifiedTime(RFC3339)を JST 'YYYY-MM-DD HH:MM' で表示する。 */
  const modifiedJst = (f: DriveFile): string => {
    if (f.modifiedTime === undefined) return '—';
    const date = new Date(f.modifiedTime);
    return Number.isNaN(date.getTime()) ? '—' : jstDateTimeString(date);
  };

  // アクセスできないショートカットの警告(v0.11)。ショートカットは共有を引き継がないため、
  // 実体の移動または実体側の共有が必要 — 同期が「静かに0件」になる事故を可視化する
  const shortcutWarning =
    listing !== undefined && listing.unresolvedShortcuts.length > 0
      ? raw(
          `<div class="alert error">ショートカット先にアクセスできないため、次の項目は同期されません: ${listing.unresolvedShortcuts
            .slice(0, 10)
            .map((s) => h(s.path === '' ? s.name : `${s.path}/${s.name}`))
            .join('、')} — ショートカットは Drive の共有権限を引き継ぎません。実体フォルダをナレッジフォルダ内へ移動するか、ショートカット先をランタイム SA に共有してください(deployment-setup.md Step 7-3)。この警告が解消されるまで、Drive から削除した文書の検索除外(チャンク掃除)も保留されます</div>`,
        )
      : raw('');

  // 「システムが実際に読んでいるフォルダ」への導線。secret のフォルダ ID と
  // 意図した場所のずれを、オペレーターがワンクリックで確認できるようにする(v0.11)
  const folderNote = html`<p class="form-help">
    同期対象フォルダ:
    <a href="https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}"
       target="_blank" rel="noopener">Drive で開く</a>
    (KNOWLEDGE_DRIVE_FOLDER_ID の場所)。この一覧に表示されないファイルは同期されません。
  </p>`;

  const fileTable =
    files === undefined
      ? html`<div class="alert error">${listErrorMessage}</div>`
      : responsiveTable(
          [
            { key: 'path', label: 'パス' },
            { key: 'name', label: '名前' },
            { key: 'modified', label: '更新日時' },
            { key: 'state', label: '同期状態' },
            { key: 'synced', label: '最終同期' },
            { key: 'ops', label: '操作' },
          ],
          [...files]
            .sort((a, b) => `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`, 'ja'))
            .map((f) => ({
              path: f.path === '' ? '(ルート)' : f.path,
              name: f.name,
              modified: modifiedJst(f),
              state: syncState(f),
              synced: chunkStats.get(f.id)?.last_synced ?? '—',
              ops: deleteForm(f),
            })),
          { emptyText: 'ナレッジフォルダに文書がありません' },
        );

  const statsNote = statsUnavailable
    ? html`<p class="form-help">同期状態を取得できませんでした(db-migrate ジョブの再実行で rag への参照権限を反映してください)</p>`
    : html``;

  // ── 今すぐ同期(BATCH_URL 未設定時はボタンを出さず自動同期の案内のみ)──
  const batchUrl = optionalEnv('BATCH_URL', '');
  const syncControl =
    batchUrl === ''
      ? html`<p class="form-help">ナレッジは毎日 06:30(JST)に自動同期されます(BATCH_URL 未設定のため「今すぐ同期」ボタンは表示されません)。</p>`
      : html`<div class="btn-row">
          <form method="post" action="${PATH}" class="inline-form">
            ${csrfField(ctx)}
            <input type="hidden" name="action" value="sync">
            <button class="btn" type="submit">今すぐ同期</button>
          </form>
          <span class="form-help">保存・削除は同期後に Chat の検索へ反映されます(自動同期は毎日 06:30)</span>
        </div>`;

  // ── 投入フォーム ──
  const industryOptions =
    `<option value="">選択してください</option>` +
    industries.rows
      .filter((i) => i.active)
      .map((i) => `<option value="${h(i.industry_id)}">${h(`${i.name}(${i.industry_id})`)}</option>`)
      .join('');
  const customerOptions =
    `<option value="">選択してください</option>` +
    customers.rows
      .map((c) => `<option value="${h(c.customer_id)}">${h(`${c.name}(${c.customer_id})`)}</option>`)
      .join('');

  // 格納先の選択 UI(ファイルアップロード・直接入力の両フォームで共通)
  const destinationFields = `<label class="field">格納先</label>
    <div class="check-grid">
      <label class="check-row"><input type="radio" name="target" value="judgement" checked> 共通(judgement/ — 判断基準・例え話)</label>
      <label class="check-row"><input type="radio" name="target" value="domain"> 業界(domain/{業界ID}/)</label>
      <label class="check-row"><input type="radio" name="target" value="customer"> 顧客(customer/{顧客ID}/)</label>
    </div>
    <div class="form-grid" style="margin-top:14px">
      <label class="field">業界(格納先が「業界」の場合に選択)
        <select name="industry_id">${industryOptions}</select>
      </label>
      <label class="field">顧客(格納先が「顧客」の場合に選択)
        <select name="customer_id">${customerOptions}</select>
      </label>
    </div>`;

  // ── ファイルアップロード投入(v0.6。PDF 対応: v0.11)──
  const fileUploadForm = html`<form method="post" action="${PATH}" enctype="multipart/form-data" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="upload_files">
    ${raw(destinationFields)}
    <label class="field" style="margin-top:14px">ファイル(複数選択可。.md / .txt は 200KB 以内・.pdf は 3MB 以内、最大 ${MAX_UPLOAD_FILES} 件・1回の送信全体で 4MB まで)
      <input type="file" name="files" multiple required accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf">
    </label>
    <p class="form-help">
      ファイル名は日本語のままで投入できます(英大文字のみ小文字に変換して保存)。
      同名ファイルが既にある場合は内容を上書きします。1件でも不正なファイルがあると全件投入されません(投入前に一括検証)。
      PDF はテキスト層のある文書のみ検索対象になります(スキャン画像のみの PDF は同期時にスキップされます)。
    </p>
    <button class="btn" type="submit">アップロードする</button>
  </form>`;

  // ── 直接入力投入(v0.4)──
  const uploadForm = html`<form method="post" action="${PATH}" class="card form">
    ${csrfField(ctx)}
    <input type="hidden" name="action" value="upload">
    ${raw(destinationFields)}
    <div class="form-grid" style="margin-top:14px">
      <label class="field">ファイル名
        <input type="text" name="file_name" required maxlength="128"
               placeholder="例: 運用手順.md"
               title="拡張子は .md / .txt(省略時は .md を付与)。日本語名も使えます">
      </label>
    </div>
    <label class="field">本文(Markdown / テキスト、最大 200KB)
      <textarea name="content" required maxlength="65000" rows="10"
                placeholder="ここに文書の本文を入力します"></textarea>
    </label>
    <p class="form-help">
      同名ファイルが既にある場合は内容を上書きします(重複ファイルは作られません)。
      保存先は Drive(SoT)で、Drive 上での直接編集も従来どおり可能です。検索への反映は同期後です。
    </p>
    <button class="btn" type="submit">保存する</button>
  </form>`;

  return html`
    ${adminTabs(PATH)}
    ${flashMessages(ctx, uploadFlash(ctx), syncFlash(ctx))}
    ${shortcutWarning}
    ${section(
      'ナレッジ文書の一覧',
      html`${fileTable}${folderNote}${statsNote}${syncControl}`,
      'SoT は Drive です。削除はゴミ箱への移動で(復元可能)、対応するチャンクは次回同期で掃除されます',
    )}
    ${section('文書の投入(ファイルアップロード)', fileUploadForm, undefined, 'upload-files')}
    ${section('文書の投入(直接入力)', uploadForm, undefined, 'upload-direct')}
  `;
}

/**
 * 格納先の検証と保存先フォルダの解決(直接入力・ファイルアップロード共通)。
 * 業界・顧客の実在性はマスタ(SoT)で検証する(セレクト偽装によるフォルダ規約外の作成を防ぐ)。
 * フォルダ作成の副作用があるため、入力(ファイル名・本文)の検証後に呼ぶこと。
 */
async function resolveUploadDestination(
  pool: pg.Pool,
  form: URLSearchParams,
  rootFolderId: string,
): Promise<{ segments: string[]; targetFolderId: string }> {
  const target = (form.get('target') ?? '').trim();
  if (target !== 'judgement' && target !== 'domain' && target !== 'customer') {
    throw invalidInput('格納先が不正です');
  }
  let industryId: string | null = null;
  let customerId: string | null = null;
  if (target === 'domain') {
    industryId = requireRef(form, 'industry_id', '業界');
    const found = await query(pool, `SELECT 1 FROM ops.industries WHERE industry_id = $1 AND active`, [
      industryId,
    ]);
    if ((found.rowCount ?? 0) === 0) {
      throw invalidInput('存在しない業界が指定されました。ページを再読み込みしてやり直してください');
    }
  }
  if (target === 'customer') {
    customerId = requireRef(form, 'customer_id', '顧客');
    const found = await query(pool, `SELECT 1 FROM ops.customers WHERE customer_id = $1`, [
      customerId,
    ]);
    if ((found.rowCount ?? 0) === 0) {
      throw invalidInput('存在しない顧客が指定されました。ページを再読み込みしてやり直してください');
    }
  }
  const segments = knowledgeFolderSegments(target, industryId, customerId);
  const targetFolderId = await ensureSubfolder(rootFolderId, ...segments);
  return { segments, targetFolderId };
}

/** ナレッジ文書の投入(直接入力・ファイル)・削除・即時同期。成功時はリダイレクト先を返す(PRG パターン)。 */
export async function handleAdminKnowledgePost(
  pool: pg.Pool,
  viewer: Viewer,
  form: URLSearchParams,
  files: MultipartFile[] = [],
): Promise<string> {
  const action = form.get('action');
  const folderId = optionalEnv('KNOWLEDGE_DRIVE_FOLDER_ID', '');
  if (folderId === '') {
    throw invalidInput(
      'KNOWLEDGE_DRIVE_FOLDER_ID が未設定のためナレッジ管理は利用できません(deployment-setup.md Step 7-3 / 7-8)',
    );
  }

  if (action === 'upload') {
    const fileName = normalizeKnowledgeFileName(form.get('file_name') ?? '');
    if (fileName.endsWith('.pdf')) {
      throw invalidInput(
        '直接入力で保存できるのは .md / .txt のみです(PDF はファイルアップロードから投入してください)',
      );
    }
    const content = form.get('content') ?? '';
    if (content.trim() === '') throw invalidInput('本文を入力してください');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > CONTENT_MAX_BYTES) {
      throw invalidInput('本文は 200KB 以内で入力してください');
    }

    const { segments, targetFolderId } = await resolveUploadDestination(pool, form, folderId);
    const result = await upsertTextFile(targetFolderId, fileName, content);
    auditLog(
      viewer,
      'knowledge.upload',
      { path: segments.join('/'), fileName, fileId: result.fileId },
      { result: result.action, contentBytes },
    );
    // upsert の結果(created / updated)をそのまま保存バナーに使う。
    // アンカーで投入フォームへ戻る(連続投入時に最上部へ飛ばされない — v0.11)
    return `${PATH}?saved=${result.action}#upload-direct`;
  }

  if (action === 'upload_files') {
    if (files.length === 0) {
      throw invalidInput('ファイルを選択してください(.md / .txt / .pdf、複数選択可)');
    }
    if (files.length > MAX_UPLOAD_FILES) {
      throw invalidInput(
        `一度に投入できるファイルは ${MAX_UPLOAD_FILES} 件までです(${files.length} 件が選択されています)`,
      );
    }
    // 投入前の一括検証(v0.6 §2: 1件でも不正なら何も保存しない)
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    const seen = new Set<string>();
    const validated: Array<{
      fileName: string;
      content: string | Buffer;
      contentBytes: number;
      mimeType: string;
    }> = [];
    for (const file of files) {
      // OS 由来の英大文字・前後空白を含むファイル名を保存名(小文字)へ寄せる
      // (trim は normalizeKnowledgeFileName と同じ扱い — 拡張子判定の前に行う)
      const lowered = file.fileName.trim().toLowerCase();
      // 「.md 自動付与」は直接入力の入力補助であり、実ファイル名を持つアップロードには
      // 適用しない(data.json → data.json.md のような対象外形式の素通り・無断改名を防ぐ — v0.6 §1)
      if (!KNOWLEDGE_FILE_EXT_PATTERN.test(lowered)) {
        throw invalidInput(
          `対応していない形式です: ${file.fileName.slice(0, 128)}(拡張子 .md / .txt / .pdf のファイルのみ投入できます)`,
        );
      }
      let fileName: string;
      try {
        fileName = normalizeKnowledgeFileName(lowered);
      } catch {
        throw invalidInput(
          `ファイル名が規約外です: ${file.fileName.slice(0, 128)}(制御文字・スラッシュを含まない 128 文字以内+拡張子 .md / .txt / .pdf)`,
        );
      }
      if (seen.has(fileName)) {
        throw invalidInput(`ファイル名が重複しています(小文字変換後): ${fileName}`);
      }
      seen.add(fileName);
      if (fileName.endsWith('.pdf')) {
        // PDF はバイナリのまま Drive へ保存する(テキスト抽出は同期側 — v0.11)
        if (file.content.length > PDF_MAX_BYTES) {
          throw invalidInput(`3MB を超える PDF は投入できません: ${fileName}`);
        }
        if (!file.content.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
          throw invalidInput(
            `PDF ファイルとして読み取れません: ${fileName}(内容が PDF 形式ではありません)`,
          );
        }
        validated.push({
          fileName,
          content: file.content,
          contentBytes: file.content.length,
          mimeType: PDF_MIME,
        });
        continue;
      }
      if (file.content.length > CONTENT_MAX_BYTES) {
        throw invalidInput(`200KB を超えるファイルは投入できません: ${fileName}`);
      }
      let content: string;
      try {
        content = utf8Decoder.decode(file.content);
      } catch {
        throw invalidInput(
          `UTF-8 のテキストではありません: ${fileName}(文字コードを UTF-8 に変換して保存し直してください)`,
        );
      }
      if (content.trim() === '') {
        throw invalidInput(`内容が空のファイルは投入できません: ${fileName}`);
      }
      validated.push({
        fileName,
        content,
        contentBytes: file.content.length,
        mimeType: 'text/markdown',
      });
    }

    const { segments, targetFolderId } = await resolveUploadDestination(pool, form, folderId);

    // 保存(Drive 書込)の部分失敗は記録して残りを継続する(原則4)。
    // ただし1件目からの失敗は設定不備(編集者共有の漏れ等)の可能性が高いため、
    // 既存の案内付きエラー(AIM-6006 → Step 7-3)をそのまま表示する(v0.6 §2)
    let created = 0;
    let updated = 0;
    const failedNames: string[] = [];
    for (const [index, file] of validated.entries()) {
      try {
        const result = await upsertFile(targetFolderId, file.fileName, file.content, file.mimeType);
        if (result.action === 'created') created += 1;
        else updated += 1;
        auditLog(
          viewer,
          'knowledge.upload',
          { path: segments.join('/'), fileName: file.fileName, fileId: result.fileId },
          { result: result.action, contentBytes: file.contentBytes, mimeType: file.mimeType },
        );
      } catch (err) {
        if (index === 0) throw err;
        logger.error('ナレッジ文書の保存に失敗しました(残りのファイルは継続)', err, {
          path: PATH,
          fileName: file.fileName,
        });
        failedNames.push(file.fileName);
      }
    }
    // 失敗ファイル名はフラッシュ表示用(URL 長の抑制のため先頭5件。全件はログに残る)。
    // 日本語名にカンマ等が含まれ得るため JSON 配列で受け渡す(v0.11)
    const failedQuery =
      failedNames.length > 0
        ? `&failed_names=${encodeURIComponent(JSON.stringify(failedNames.slice(0, 5)))}`
        : '';
    return `${PATH}?uploaded=1&created=${created}&updated=${updated}&failed=${failedNames.length}${failedQuery}#upload-files`;
  }

  if (action === 'delete') {
    const fileId = (form.get('file_id') ?? '').trim();
    if (!DRIVE_FILE_ID_PATTERN.test(fileId)) {
      throw invalidInput('ファイルIDが不正です。ページを再読み込みしてやり直してください');
    }
    // 削除対象がナレッジフォルダ配下であることを検証する
    // (SA に共有された他ファイルの ID を偽装 POST されてもゴミ箱移動させない)
    const { files } = await listFilesRecursive(folderId);
    const target = files.find((f) => f.id === fileId);
    if (target === undefined) {
      throw invalidInput('ナレッジフォルダ配下にないファイルは削除できません。ページを再読み込みしてやり直してください');
    }
    // 監査ログ用の補助情報。検証で削除を止めない(長すぎる名前は切り詰める)
    const fileName = (form.get('file_name') ?? '').trim().slice(0, 500) || null;
    // ショートカット経由のファイルはショートカット側をゴミ箱へ移動する
    // (実体は元の場所に残す — ナレッジからの除外が意図で、元データの削除ではない: v0.11)
    await trashFile(target.shortcutId ?? fileId);
    auditLog(viewer, 'knowledge.delete', { fileId, fileName, shortcutId: target.shortcutId ?? null }, {});
    return `${PATH}?saved=deleted`;
  }

  if (action === 'sync') {
    const batchUrl = optionalEnv('BATCH_URL', '');
    if (batchUrl === '') {
      throw invalidInput(
        'BATCH_URL が未設定のため「今すぐ同期」は利用できません(毎日 06:30 の自動同期をお待ちください)',
      );
    }
    // batch の /jobs/knowledge-sync を起動する(状況確認と共通のヘルパー)
    return triggerBatchJob({
      batchUrl,
      jobName: 'knowledge-sync',
      jobLabel: '今すぐ同期',
      viewer,
      waitMs: SYNC_WAIT_MS,
      errorCode: ERROR_CODES.SYNC_TRIGGER_FAILED,
      auditAction: 'knowledge.sync',
      auditDetails: {},
      redirectBase: PATH,
      successParam: 'synced',
      errorParam: 'sync_error',
    });
  }

  throw invalidInput('不明な操作です');
}
