# AI マネージャー要件定義 v0.12 追補 — 対話の終了制御・エスカレーション解決導線・プロジェクトナレッジ・会話履歴参照・ジョブ手動実行・対話フィードバック

> **位置づけ:** 本書は `ai-manager-requirements-design.md`(v0.2)への**追補**であり、v0.2 本文は変更しない。
> 既存の追補(v0.3〜v0.11)と本書が矛盾する場合は本書(v0.12)を優先する。
> **背景:** オペレーター要望(2026-07-13)
> ①「問いかけに回答すると AI から延々と質問がやってきて終わらない。閾値かターンカウントで質問を終えるようにしてほしい」
> ②「エスカレーションの解決導線がない。管理者からメッセージを送る/AI マネージャーにフィードバックを送る/回答不要とする等のアクションで解決できるようにしてほしい」
> ③「プロジェクトに対してもナレッジをセットできるようにしてほしい(目的・要件・設計・マイルストーン・スケジュール・議事録等)」
> ④「AI は会話の履歴を参照して回答してほしい。ひとつ前の対話の内容で話を進められないのは不便」
> ⑤「スケジューラで実行される集計等を画面のボタン押下でも実行できるようにしてほしい」
> ⑥「メンバーと AI マネージャーの対話ログを画面から確認し、回答に不備がある場合は正しい回答のフィードバックを行えるようにしてほしい。フィードバックを受けた AI はそれを加味したうえで、本人に謝罪し回答を修正するメッセージを送ってほしい」

## 1. 背景と課題

| # | 課題 | 現状 |
|---|---|---|
| C19 | 朝・夕の問いかけ対話に終了条件がターン数として存在しない | 朝は hypothesis 確定・夕は review 確定まで「返信待ち」が続き、LLM が確定マーカーを返さない限り問い返しが際限なく続く(状況確認のみ v0.5 で上限 7 ターンあり) |
| C20 | エスカレーションの解決導線がない | 解決は Chat の「裁定を記録」カードのみ。ダッシュボードは閲覧のみで、質問者への回答送付・回答不要のクローズができず open が滞留する |
| C21 | プロジェクトにナレッジを持てない | ナレッジの帰属は共通/業界/顧客のみ(v0.3)。プロジェクトの要件・設計・議事録等を検索対象として持つ場所がない(v0.10 の計画情報は目的・内容・マイルストーンの構造化項目のみ) |
| C22 | 随時 QA が会話履歴を参照しない | QA は毎回単発の 1 ターンで、直前のやり取り(「さっきの件」「その顧客」)を解決できない(朝夕対話は同一対話内のみ履歴あり) |
| C23 | 定時ジョブ・集計を画面から実行できない | 手動実行できるのは「今すぐ同期」(knowledge-sync)と状況確認(adhoc-checkin)のみ。日次 ETL(pg_cron)や朝の問いかけ・日報等は待つしかない |
| C24 | 対話ログの確認と回答不備の是正手段がない | ダッシュボードの閲覧ロールは生の対話ログを参照できない(要件 7.5 の設計)。AI の誤回答に気づいても、本人への訂正と AI への学習をさせる導線がない |

## 2. 対話の終了制御(C19 対応)

- 朝の問いかけ(morning_checkin)・夕の振り返り(completion_review)に**ターン数上限**を導入する
  (状況確認 v0.5 の `ADHOC_CHECKIN_MAX_TURNS` と同じ機構):
  - 朝: **11 ターン**(AI の初回問いかけ 1+5 往復)= `MORNING_DIALOGUE_MAX_TURNS`
  - 夕: **10 ターン**(本人の申告から 5 往復)= `COMPLETION_REVIEW_MAX_TURNS`
- 上限に達した対話は仮説・レビュー未確定でも「返信待ち」から外れ、以後のメッセージは通常の
  ルーティング(QA 等)で処理される(延々と質問が続かない)
- **上限直前の往復では締めの指示をプロンプトに注入**する: 問い返しを禁止し、不足項目は AI が
  参考情報から補って仮説/レビューを確定(ai_assisted=true)し、要約とお礼で締める
- 通常時のプロンプトにも「問い返しは対話全体で数回まで。同じ趣旨の問いを繰り返さない」を明記し、
  上限は保険として機能させる(2層の防御)

## 3. エスカレーションの解決導線(C20 対応)

ダッシュボードに管理者限定ページ **エスカレーション**(`/admin/escalations`)を追加する。

- 一覧: open 全件+直近 30 日の解決済み(理由・対象メンバー・状況・解決内容)
- open のエスカレーションへの**解決アクション**(オペレーター要望の 3 択に対応):

| アクション | 動作 | resolution_type |
|---|---|---|
| メンバーへ回答を送信して解決 | 管理者の入力文を「(管理者からの回答です)」プレフィックス付きで対象メンバーの DM へ送信し、対話ログ(dialogue_type='escalation')に記録して解決 | admin_message |
| AI マネージャーへフィードバック(裁定を記録) | 従来の裁定フロー(M6)と同じ: resolution を保存し decision_rules ナレッジへ還流(以後の回答に反映) | ruling |
| 回答不要として解決 | 対応不要としてクローズ(還流・送信なし) | no_action |

- 解決済みで**ナレッジ未還流**(還流失敗)のものには「ナレッジ還流を再試行」を表示する(手動回復パス — 原則 6)
- **実行主体は batch**(新ジョブ `escalation-action`。v0.5 §2 の権限境界の原則を踏襲):
  dashboard には Chat 送信権限・ops/rag への書込権限を持たせず、OIDC でジョブを起動するだけとする
- 回答送信は、解決の記録(open→resolved)を**送信前にアトミックにクレーム**して並行操作の
  二重送信を防ぎ(敗者は DM を送らずスキップ)、その後「対話レコード作成(SoT)→送信→
  失敗時は補償(対話レコード削除+open へ戻す)」の adhoc-checkin 型パターンで配信する。
  送信できなければエスカレーションは open に戻る(解決済みなのに未回答、という不整合を作らない)
- `ops.escalations.resolution_type` 列を追加。既存の解決済み行は全て Chat の裁定のため
  'ruling' へバックフィルする(下位互換 — 原則 7)
- Chat の「裁定を記録」フロー(M6)は従来どおり動作する(resolution_type='ruling' が付くのみ)

## 4. プロジェクトナレッジ(C21 対応)

- Drive フォルダ規約に **`project/{プロジェクトID}/`** を追加し、配下の文書を
  `doc_type='project_doc'`・`project_id={プロジェクトID}` として同期する
  (`rag.knowledge_chunks` に project_id 列を追加。業界 v0.3 §3.4・顧客と同じ分類機構)
- プロジェクトの要件・設計・スケジュール・議事録など、**文書として持つべき情報**はプロジェクト
  ナレッジに置く。目的・内容・マイルストーンの**構造化項目**は従来どおり v0.10 の計画情報
  (プロジェクト編集ページ)が担う(両者は併存し、いずれも AI へ供給される)
- ナレッジ管理ページ(/admin/knowledge)の格納先に「プロジェクト」を追加する(顧客と同じ選択方式)
- 随時 QA での検索スコープ: **対象プロジェクトが特定できた質問**(v0.10 §4.2 の特定方法)では
  そのプロジェクトの固有ナレッジを検索対象に含める。特定できない質問ではプロジェクト固有
  ナレッジを除外する(顧客スコープ v0.3 §4.2 と同じ誤混入防止)
- 規約のプロジェクト ID がマスタ(ops.projects)に無い場合は警告ログ+取り込み継続(顧客と同じ扱い)

## 5. 随時 QA の会話履歴参照(C22 対応)

- 随時 QA のプロンプトに**本人の直近の対話履歴**を供給する: 直近 24 時間の対話(種別不問)を
  新しい順に 5 件まで集め、ターンを時系列に平坦化して**末尾 12 ターン**をマルチターン履歴として渡す
  (朝夕対話の既存上限 MAX_CONTEXT_TURNS と同じ値 — プロンプト肥大の防止)
- 対話の境界で同一ロールが連続する場合は 1 メッセージに結合する(Vertex のマルチターン規約)
- 履歴の取得失敗は QA をブロックしない(履歴なしで回答 — 原則 4)
- 朝夕対話・状況確認は従来どおり同一対話内の履歴を使う(変更なし)

## 6. 定時ジョブ・集計の手動実行(C23 対応)

ダッシュボードに管理者限定ページ **ジョブ実行**(`/admin/jobs`)を追加する。

- 対象: 集計(日次 ETL)・朝の問いかけ・日報生成・週次サマリ・異常検知・ナレッジ同期
- 集計は新ジョブ `daily-etl` が `dwh.run_daily_etl()` を実行する。手動実行の対象日は
  **当日のみ**(「今日の途中経過を今すぐ集計に反映する」が目的。対象日のファクトは洗い替えで冪等、
  翌日の pg_cron 定時実行が同じ日を再度洗い替えるため巻き戻りもない)。
  過去日は API から指定できない: fact_workload は「実行時点の状態」を対象日ラベルで書く
  日次スナップショットのため、過去日の再実行は確定済み履歴を今日の状態で上書きしてしまう
  (原則2)。ETL 関数側にも「前日より古い対象日では既存スナップショットを上書きしない
  (欠落補完のみ)」の保護を入れる(直接実行への多層防御)
- `dwh.run_daily_etl` は **SECURITY DEFINER** 化し、batch の DB ロール(ai_manager_app_rw)へは
  **この関数の実行権限のみ**を付与する(dwh 表への直接書込権限は与えない — 最小権限。
  PUBLIC からは実行権限を剥奪。pg_cron の定時実行は従来どおり)
- 手動実行はすべて既存ジョブの再入(朝の問いかけの 1 日 1 回ガード、日報の confirmed 保護、
  異常検知のクールダウン等)に乗るため、**ボタンの再押下で既存データは巻き戻らない**(原則 2)
- 起動は既存の triggerBatchJob(OIDC)パターン。ナレッジ管理ページの「今すぐ同期」は従来どおり残す

## 7. 対話ログの確認とフィードバック(C24 対応)

ダッシュボードに管理者限定ページ **対話ログ**(`/admin/dialogues`)を追加する。

- ユーザー・日付でフィルタし、対話のターン(本人/AI)を展開表示する
- **権限境界の改訂:** 生の対話ログ(ops.dialogues)の参照は、閲覧ロール
  (ai_manager_dashboard_ro)には引き続き付与せず(要件 7.5 の境界は維持)、
  管理者限定ページ専用の書込ロール(ai_manager_admin_rw)にのみ SELECT を付与する
  (アプリ層の管理者限定と合わせた二重制御。管理者の対話ログ閲覧は要件 3.1
  「全ダッシュボード閲覧」の範囲内)
- 回答に不備がある対話への**フィードバック**: 管理者が正しい回答・指摘を入力すると、
  新ジョブ `dialogue-feedback`(batch)が以下を実行する:
  1. `ops.dialogue_feedback` へ記録(SoT。status='pending')
  2. ナレッジへ還流: 元対話(質問と誤回答)+フィードバックを 1 チャンクに整形し、
     `doc_id='feedback/{id}'`・`doc_type='decision_rules'` で rag へ UPSERT
     (ADR-11 の裁定還流と同じパターン。**以後の回答にフィードバックが加味される**。
     失敗は非ブロッキングで、再送時に再試行)
  3. **謝罪+訂正メッセージ**を生成(pro。元対話とフィードバックを文脈に、お詫び+正しい内容)し、
     本人の DM へ送信して対話ログ(dialogue_type='feedback_correction')に記録する。
     生成失敗時はフィードバック本文を引用する定型文で確実に届ける(原則 4)
  4. 配信は送信前に pending→delivered をアトミックにクレームし、並行起動の二重配信を防ぐ。
     **送信失敗時は補償で pending へ戻り、画面の「再送」で回復できる**(手動回復パス — 原則 6。
     delivered の再送は拒否)。送達済みで還流のみ未了の場合は画面の「ナレッジ再還流」
     (refluxOnly)で DM を送らずに還流だけを再試行できる
- knowledge-sync の削除掃除は `feedback/%` チャンクを保護する(escalation/% と同様 —
  Drive 由来でない還流キャッシュを「削除された文書」と誤判定して消さない)

## 8. データ境界・SoT 宣言

| データ | SoT | キャッシュ | 備考 |
|---|---|---|---|
| エスカレーションの解決(resolution / resolution_type) | ops.escalations | rag の escalation/{id} チャンク(ruling のみ) | 既存 ADR-11 の拡張 |
| 対話フィードバック | ops.dialogue_feedback | rag の feedback/{id} チャンク | SoT 書込 → 還流 → 送達の順 |
| 訂正メッセージ | ops.dialogues(feedback_correction) | — | 送信失敗時は補償削除(adhoc-checkin と同じ) |
| プロジェクトナレッジ | Google Drive(project/{ID}/) | rag.knowledge_chunks(project_id 付き) | v0.4 の投入・同期フローに乗る |
| ops.dialogue_feedback → ops.dialogues の参照 | — | — | dialogues は複合 PK のパーティション表のため FK は張れない。dialogue_id+dialogue_created_at の両列で参照する(設計判断として記録) |

## 9. スコープ外(本追補では実施しない)

- 朝夕対話・状況確認へのプロジェクトナレッジ(RAG)供給 — 検索クエリを持つ随時 QA のみが対象。
  朝夕へは v0.10 の計画情報供給が引き続き有効
- メンバー本人による対話ログ閲覧・フィードバック(管理者のみ。/me の振り返りは従来どおり)
- フィードバックの編集・取り消し(誤登録は再度フィードバックを登録して上書きの訂正を送る運用)
- ターン数上限の画面からの設定変更(定数。運用で不足が確認された時点で環境変数化を検討)
- pg_cron 側の定時 ETL の廃止(手動実行は追加の導線であり、定時実行は従来どおり)

## 10. 受け入れ基準

1. 朝の問いかけで答えが揃わない返信を繰り返しても、5 往復目までに AI が補って仮説を確定し
   対話が締まる(以後のメッセージは QA として扱われる)。夕の振り返りも同様(5 往復)
2. エスカレーションに対し「メンバーへ回答送信」「AI へフィードバック(裁定)」「回答不要」の
   いずれの操作でも解決でき、回答送信は本人の DM に届き対話ログに記録される
3. project/{プロジェクトID}/ に投入した文書が同期され、そのプロジェクトに言及した質問で
   検索対象になる。他プロジェクトの質問・プロジェクト不特定の質問では検索対象にならない
4. 直前の QA のやり取りを踏まえた質問(「その会社の業種は?」)に文脈を保って回答できる
5. ジョブ実行ページから集計(ETL)を実行すると、当日分の集計がダッシュボードへ反映される。
   全ジョブがボタン再押下で既存データを巻き戻さない
6. 対話ログページで AI の回答を確認してフィードバックを登録すると、本人へ謝罪+訂正 DM が届き、
   同じ内容の質問に対して以後フィードバックが加味された回答が返る。訂正送信の失敗は
   「再送」で回復できる
7. 下位互換(原則 7): 追加は列(resolution_type / project_id)+新テーブル(dialogue_feedback)+
   CHECK 制約の値追加のみ。既存の解決済みエスカレーションは 'ruling' へバックフィル
   (migration 0010 内で完結 — 手動のデータ更新パッチ不要)。Chat の裁定フロー・既存ナレッジ・
   既存対話への影響なし

## 11. 実装との対応

| 要件 | 実装 |
|---|---|
| §2 ターン上限・締め | `packages/shared/src/prompts.ts`(MORNING_DIALOGUE_MAX_TURNS / COMPLETION_REVIEW_MAX_TURNS / DIALOGUE_CLOSING_NOTE)、`packages/chat-gateway/src/services/dialogues.ts`(findOpenDialogue)、`handlers/message.ts`(closingNoteFor) |
| §3 解決導線 | `packages/db/migrations/0010_feedback_escalation_project_knowledge.sql`、`packages/shared/src/escalations.ts`(共通化)、`packages/batch/src/jobs/escalation-action.ts`、`packages/dashboard/src/pages/admin/escalations.ts` |
| §4 プロジェクトナレッジ | migration 0010(rag.project_id / project_doc)、`packages/batch/src/drive.ts`(classifyDocument)、`jobs/knowledge-sync.ts`、`packages/chat-gateway/src/services/rag.ts`(projectId スコープ)、`handlers/message.ts`(QA)、`packages/dashboard/src/pages/admin/knowledge.ts`(格納先) |
| §5 会話履歴 | `packages/chat-gateway/src/services/dialogues.ts`(fetchRecentTurns)、`handlers/message.ts`(answerAdhocQuestion / mergeConsecutiveTurns) |
| §6 手動実行 | `packages/db/etl/20_daily_etl.sql`(SECURITY DEFINER)/`30_grants.sql`(EXECUTE)、`packages/batch/src/jobs/daily-etl.ts`、`packages/dashboard/src/pages/admin/jobs.ts` |
| §7 対話フィードバック | migration 0010(ops.dialogue_feedback / feedback_correction)、`packages/batch/src/jobs/dialogue-feedback.ts`、`packages/dashboard/src/pages/admin/dialogues.ts`、`30_grants.sql`(admin_rw への dialogues/dialogue_feedback SELECT) |
| エラーコード | `packages/shared/src/errors.ts`(AIM-5005 / 5006 / 6009 / 6010 / 6011)、`docs/operations/error-codes.md` |

---

*v0.12 追補(2026-07-13)— オペレーター要望に基づく。基底文書: ai-manager-requirements-design.md(v0.2)*
