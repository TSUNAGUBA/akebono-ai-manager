# Phase 2 実装設計

- 上位ドキュメント: [ai-manager-requirements-design.md](../refference/ai-manager-requirements-design.md)(v0.2)+
  [v0.3 追補](../refference/ai-manager-requirements-v0.3-addendum.md)+
  [v0.7 追補](../refference/ai-manager-requirements-v0.7-addendum.md)
- 前提: [phase1-implementation.md](./phase1-implementation.md)(ADR-1〜9 は引き続き有効)
- 方針: **全機能を実装し、運用は環境変数/secrets のフラグで段階的に有効化する**(オペレーター判断 2026-07-09)

## 1. 実装スコープ

| モジュール | 状態 | 実装 |
|---|---|---|
| v0.3 マスタ+ナレッジスコープ | **実装済み** | 業界/顧客×業界/関係種別/顧客間関係の4マスタ(migration 0004)、1〜2ホップのスコープ導出(再帰CTE)、RAG 前置フィルタ、knowledge-sync の業界帰属+マスタ突合 |
| v0.3 マスタ管理 UI | **実装済み** | 管理者限定 /admin/*(業界・顧客・関係の CRUD、CSRF 二重送信クッキー __Host-、監査ログ、専用書込ロール ai_manager_admin_rw、未構成時は案内表示) |
| v0.4 ナレッジ管理 UI | **実装済み** | 管理者限定 /admin/knowledge(Drive 文書の一覧+rag 同期状態、共通/業界/顧客への投入・同名上書き・ゴミ箱移動、knowledge-sync の即時起動)。v0.6 でファイルアップロード投入(複数可・.md/.txt・投入前一括検証)を追加。SoT は Drive のまま(UI は投入経路。rag への直接書込はしない)。書込はランタイム SA 自身のトークンで行い、実効権限境界は共有 ACL(v0.4 §2) |
| M3 タスクオーケストレーション | **実装済み** | 管理者の指示検知(明示プレフィックス確定+flash-lite 分類)→ pro で分解(subtasks/工数/期限/担当案)→ 承認カード → 担当へ DM 配信 → 対話からの進捗自動更新(着手・完了) |
| M6 異常シグナル検知 | **実装済み** | anomaly-scan バッチ(平日 09:30): 停滞・過負荷・仮説表明率の急落を決定的 SQL+閾値で検知、クールダウン付き起票+管理者通知 |
| M6 裁定ナレッジ還流 | **実装済み** | エスカレーションの「裁定を記録」→ resolution 保存 → decision_rules として rag へ embedding 付き還流(ADR-11) |
| カレンダー連携(M2 拡張) | **実装済み(フラグ)** | ドメイン全体委任(SA キーレス、IAM signJwt)で本人の当日予定を取得し朝の問いかけへ反映 |
| v0.7 顧客マスタ情報の回答参照 | **実装済み** | 随時 QA で対象顧客のマスタ情報(名称・所属業界・1ホップの顧客間関係)を SoT(ops マスタ)から毎回直接取得し「顧客マスタ情報」ブロックとしてプロンプトへ供給(ADR-13)。対象顧客の特定は「①質問文の名称照合 ②対話文脈」の優先順に改訂(v0.7 §4)。取得失敗は非ブロッキング(ナレッジのみで回答継続) |
| v0.10 プロジェクト計画情報・タスク進捗管理・AI 文脈供給 | **実装済み** | projects に内容・目的(任意列)+project_milestones(migration 0009)。プロジェクト編集ページでマイルストーン CRUD・所属タスクの状態更新(task_status_log へ changed_via='admin' で記録。起票は M3 が SoT のまま — ADR-16)。計画情報を朝の問いかけ/状況確認/QA のプロンプトへ SoT 直接参照で供給(shared/project-context.ts。未入力項目は省略)。QA の対象プロジェクト特定は顧客特定と同じ優先順で独立に実施 |
| v0.11 ナレッジ同期の診断性・PDF・規約撤廃・フォーム改善 | **実装済み** | Drive ショートカットの実体解決(共有を引き継がない制約は UI 警告+同期ログで可視化。未解決時はチャンク掃除をスキップ — 原則2)、ナレッジ管理ページに同期対象フォルダへの導線。PDF 投入(バイナリのまま Drive 保存・3MB)+同期時のローカルテキスト抽出(unpdf — ADR-17。テキスト層なしはスキップ+警告)。ファイル名の文字種制限を撤廃(日本語名可・失敗名の受け渡しを JSON 化)。管理 UI の textarea 独立行化・date/file 入力のスタイル統一・PRG リダイレクトのセクションアンカー+sticky バナー |
| v0.9 プロジェクト管理 UI・優先順改訂・エイリアス・耐障害性 | **実装済み** | プロジェクトの管理者限定 CRUD(/admin/projects。物理削除なし・状態 closed 運用)。明示的タスク指示を進行中対話より優先(ADR-15)。顧客エイリアス照合(migration 0008。設計 SoT は phase3-and-migration-design.md §2)+low エスカレーションへの対象顧客診断情報。対話継続の LLM 失敗時に返信ターンを保存して定型文フォールバック、QA 補助処理(スコープ導出・ナレッジ検索)の非ブロッキング化、汎用エラー文言への AIM コード付与 |
| v0.8 問いかけ対象のユーザー単位設定 | **実装済み** | ops.users.checkin_enabled(migration 0007。既存行は member=可 / admin=不可で初期化 — 従来動作の保存)。morning/adhoc-checkin の対象クエリと状況確認画面をロール固定からフラグへ変更。管理者限定 /admin/users で可否を切替(監査ログ・CSRF)。ai_manager_admin_rw へ ops.users の列単位 GRANT(ADR-14) |
| v0.12 対話の終了制御・エスカレーション解決導線・プロジェクトナレッジ・会話履歴参照・ジョブ手動実行・対話フィードバック | **実装済み** | 朝・夕対話のターン数上限(11/10)+上限直前の締め指示注入(質問ループの終了制御)。管理者限定 /admin/escalations(回答送信/裁定/回答不要/再還流 — 実行主体は batch の escalation-action ジョブ、ADR-18)。Drive 規約 project/{ID}/ → doc_type=project_doc のプロジェクトナレッジ(migration 0010。QA は対象プロジェクト特定時のみ検索対象に含める)。随時 QA へ直近 24h・末尾 12 ターンの会話履歴を供給。管理者限定 /admin/jobs から全定時ジョブ+日次 ETL の手動実行(dwh.run_daily_etl を SECURITY DEFINER 化し app_rw へ実行権限のみ付与 — ADR-19)。管理者限定 /admin/dialogues で対話ログ確認+フィードバック → AI が謝罪+訂正 DM を送信し decision_rules へ還流(dialogue-feedback ジョブ、ADR-20) |
| v0.5 管理者発火の状況確認 | **実装済み** | 管理者限定 /admin/checkin(active メンバー一覧+当日の朝/状況確認の応答状況、個別・全員への送信)。配信は batch の adhoc-checkin ジョブ(OIDC 起動・1日1回ガードなし。DM 未登録と、朝の問いかけ/振り返りに応答中のメンバーはスキップ — 対話の横取り防止、v0.5 §2-5)。文面は flash-lite 生成+定型文フォールバックで、冒頭に管理者発火を明示。返信は adhoc_checkin 対話として ops.dialogues に保存され、仮説形成を要求しない軽量な継続で2〜3往復の自然クローズ(migration 0006 で dialogue_type と dwh.dim_dialogue_type を拡張) |

## 2. 段階運用の切り分け(フラグ一覧)

「実装は全部・有効化は段階的に」の制御点。すべて未設定でも Phase 1 相当+M3/M6 で安全に動作する。

| フラグ / 閾値 | 既定 | 内容 |
|---|---|---|
| `CALENDAR_ENABLED`(secret) | 無効 | 朝の問いかけへの予定反映。Workspace のドメイン全体委任が前提(deployment-setup.md Step 7-6) |
| `DASHBOARD_ADMIN_DB_ENABLED`(secret) | 無効 | マスタ管理 UI の書込接続(Step 7-7)。無効時は案内表示 |
| `KNOWLEDGE_SCOPE_HOPS`(secret) | 1 | 関係グラフの探索ホップ数(最大 2) |
| `KNOWLEDGE_SCOPE_FALLBACK`(secret) | exclude-customer | 対象顧客が特定できない場合の動作(`all` で v0.2 互換の全域検索) |
| `ANOMALY_STALL_DAYS` / `ANOMALY_OVERLOAD_TASKS` / `ANOMALY_QUALITY_MIN_SAMPLES` / `ANOMALY_COOLDOWN_DAYS`(secret) | 3 / 7 / 3 / 7 | 異常検知の閾値 |

## 3. 設計判断の記録(ADR)

### ADR-10: Phase 2 でも Agent Engine を導入しない(ADR-3 の再評価)

- **決定**: M3/M6 は既存 TS スタックの**確定的フロー+LLM 呼び出し**で実装した。
  要件 §8 の `packages/agent`(Vertex AI Agent Engine)は引き続き見送る
- **理由**: 要件 M3 のフロー(指示→分解→承認→配信)は要件自体が確定的な状態機械であり、
  プランニング/動的ツール選択を必要としない。カレンダー参照も読み取り 1 API のため
  ドメイン全体委任での直接実装で足りる。Python/ADK スタックの追加は運用面(ビルド・監視・
  デプロイの二重化)のコストが大きく、5 ユーザー規模に見合わない
- **再検討条件**: 複数ツールを跨ぐ動的なプランニング(例: メール+カレンダー+タスクを
  組み合わせた自律行動)が要件化された時点。プロンプト SoT は shared/prompts.ts に
  集約済みで、エージェント移行時もそのまま供給できる(ADR-3 の方針を維持)

### ADR-11: 裁定ナレッジの SoT は ops.escalations、rag はキャッシュ

- **決定**: 管理者の裁定は `ops.escalations.resolution` に保存し(SoT)、
  `rag.knowledge_chunks` へ `doc_id='escalation/{id}'`・`doc_type='decision_rules'` で還流する(キャッシュ)。
  knowledge-sync の掃除処理は `escalation/` 由来チャンクを削除対象から除外する
- **理由**: 要件 M6「裁定結果はナレッジ(judgement/decision-rules.md)へ還流」を、
  Drive 文書への書込(Drive 書込権限+競合管理が必要)ではなく DB 内還流で実現する。
  SoT → キャッシュの書込順序を守り(開発原則 6)、再還流は冪等(ON CONFLICT 上書き)
- **トレードオフ**: Drive の decision-rules.md 原本には自動反映されない(v0.3 の
  「SoT から復元できないデータの文書化」に該当)。原本への反映は管理者の手動作業とし、
  検索には還流チャンクが即時に効くため運用上の欠落はない

### ADR-12: 異常検知は LLM を使わず決定的 SQL+閾値で行う

- **決定**: M6 の異常シグナル(停滞・過負荷・回答の質の急落)は SQL と環境変数の閾値で検知する
- **理由**: 監視は再現可能性が最重要(同じ状態なら同じ検知結果)。LLM 判定は
  誤検知/見逃しの原因が説明できず、閾値調整もできない。「回答の質」も
  仮説表明率という測定可能な代理指標に落とした(dwh の観察データ思想と同旨)
- **トレードオフ**: 意味的な異常(内容の空洞化など)は捉えられない。Phase 3 の
  判定材料整備で指標を追加する余地を残す

### ADR-13: 顧客マスタ情報はクエリ時に SoT から直接供給する(rag への文書化同期はしない)

- **決定**: 随時 QA の「顧客マスタ情報」ブロック(要件 v0.7 §3)は、回答のたびに
  ops マスタ(customers / customer_industries / customer_relations / relation_types)から
  決定的 SQL で直接取得してプロンプトへ埋め込む。マスタの CRUD や手動トリガーで
  ナレッジ文書を生成して rag へ同期する方式は採用しない
- **理由**: ①文書化同期は SoT → キャッシュの同期パスを増やし、CRUD フック漏れ・削除同期漏れ・
  トリガー押し忘れで古い関係情報が回答に混入する(開発原則 1・6)。直接参照は常に最新で冪等。
  ②ベクトル類似検索経由では「取引先一覧」のような列挙質問で該当チャンクが top-k に入る保証がなく、
  同種のインシデント(しまむら取引先・2026-07-13)が再発しうる。直接供給は対象顧客が特定できれば
  必ず全関係が渡る。③embedding 費用・同期ジョブ・回復経路が不要で、顧客数十・エッジ数百の
  規模ではクエリ 1 往復の追加コストは軽微
- **トレードオフ**: マスタ情報は対象顧客が特定できた QA でしか供給されない(マスタ横断の
  意味検索はできない)。プロンプトサイズは関係エッジ数に比例して増える
- **再検討条件**: 対象顧客あたりの関係エッジが数百件を超えた時点、またはマスタ横断の
  意味検索(「アパレルの納品先を持つ顧客は?」等)が要件化された時点

### ADR-14: 問いかけ対象はロールではなくユーザー単位フラグで選定し、UI 書込は列単位 GRANT で限定する

- **決定**: 朝の問いかけ・状況確認の配信対象を `role = 'member'` 固定から
  `ops.users.checkin_enabled`(ユーザー単位フラグ)に変更した(要件 v0.8)。設定 UI は
  管理者限定 /admin/users とし、書込ロール ai_manager_admin_rw には ops.users の
  **列単位の権限**(一覧表示列の SELECT+checkin_enabled のみの UPDATE)だけを追加した
- **理由**: ①ロールは権限の軸であり問いかけの要否とは独立した関心事(管理者に届けたい/特定
  メンバーには止めたいの両方をロール変更なしで実現する)。②表レベルの GRANT では UI 経由で
  名前・ロール・active まで変更可能になり、v0.3 §5.1 の「ユーザーマスタは SQL 運用」の境界が
  崩れる。列単位 GRANT なら UI で変更できる範囲が機能要件と正確に一致する
- **下位互換**: migration 0007 が既存行を従来動作(member=可 / admin=不可)で初期化するため、
  適用直後の配信対象は変わらない。seed テンプレートは ON CONFLICT で checkin_enabled を
  上書きしない(再実行が UI の設定を巻き戻さない — 原則2)
- **トレードオフ**: 問いかけ種別ごとの細分化(朝のみ可等)はできない(必要になった時点で
  列追加を判断)。日報・週次サマリ等のレポート系は従来どおりロール基準(v0.8 §6)。
  管理者を問いかけ可にすると、open な朝の対話がタスク指示(M3)を吸収し得る
  (進行中対話の継続が指示検知より優先されるため — 既知の制約として v0.8 §3.4 に運用
  ガイダンスとともに文書化。M3 の優先順自体は変更しない)

### ADR-15: 明示的なタスク指示のみ進行中対話より優先する(M3 優先順の部分改訂)

- **決定**: MESSAGE ハンドラの優先順で、管理者の**ルールベース確定シグナル**(「タスク:」等の
  明示プレフィックス)によるタスク指示のみを進行中対話の継続より先に評価する(要件 v0.9 §3)。
  担当者・期限・依頼動詞のヒューリスティックによる曖昧なシグナル(flash-lite 分類を要する)は
  従来どおり対話の継続を優先する
- **理由**: 明示プレフィックスは誤検知の余地がない確定シグナルであり、対話保護(横取り防止)の
  必要がない。全面的に指示検知を優先すると、朝夕対話の途中の「〜さんに対応してもらいます」の
  ような発話が誤って起票される(v0.5 までの設計判断を曖昧シグナルについては維持)
- **トレードオフ**: 曖昧な表現の指示(プレフィックスなし)は、進行中対話がある間は起票されない
  (対話クローズ後に送り直す運用)。LLM 分類に「対話継続か指示か」を判定させる案は、
  誤分類が再現不能な形で対話を壊すため採用しない

### ADR-16: タスク進捗の UI 管理は「状態の更新のみ」を列単位権限で許可する

- **決定**: プロジェクト編集ページ(v0.10)からのタスク操作は状態の更新に限定し、
  ai_manager_admin_rw へは ops.tasks の SELECT+**status / updated_at / completed_at 列のみの
  UPDATE**+task_status_log の SELECT / INSERT を付与する。タスクの起票(INSERT)・削除・
  題名/担当/期限の変更は UI からもロールからも不可のままとする
- **理由**: タスク作成は M3(Chat の指示 → AI 分解 → 承認カード → 担当へ DM 配信)が SoT で、
  UI からの直接起票は承認フロー・配信・対話ログの整合を壊す。一方で「プロジェクト単位で
  タスクを見渡して進捗を直したい」という運用要求(v0.10 C12)は状態の更新だけで満たせる。
  列単位 GRANT により UI で可能な操作と DB 権限を正確に一致させる(ADR-14 と同じ手法)
- **整合の担保**: 状態遷移は既存原則どおり task_status_log と同一トランザクションで記録し
  (changed_via='admin')、dwh の fact_task_activity へ既存 ETL 経由で反映される。
  同一状態への更新は no-op(履歴の汚染・冪等性の両立)
- **トレードオフ**: 期限・担当の修正は SQL 運用のまま(必要になった時点で列単位 GRANT の
  追加を判断)。completed_at は done 以外への遷移で NULL に戻る(再オープンの分析上の扱いは
  fact_task_activity の遷移履歴が正)

### ADR-17: PDF のテキスト抽出は同期バッチ内でローカルに行う(unpdf)

- **決定**: PDF ナレッジ(v0.11)のテキスト抽出は knowledge-sync のプロセス内で
  pure-JS の抽出ライブラリ(unpdf / pdfjs)により行う。Drive の Google Docs 変換や
  Vertex AI(Gemini のマルチモーダル入力)による抽出は採用しない
- **理由**: ①同期は毎日全ファイルの本文を取得して content_hash 差分を取る設計のため、
  抽出は「毎回・冪等・ゼロコスト」である必要がある(LLM 抽出は毎同期で課金され、
  出力の揺れが hash 差分を汚し embedding の再計算を誘発する)②Drive の Docs 変換は
  SoT の隣に派生ファイルを生む(SoT 分裂 — v0.4 §2 に反する)③抽出結果はそのまま
  既存のチャンク分割 → 差分 embedding フローに乗り、新しい同期パスを作らない(原則3)
- **制約の明示**: テキスト層のない PDF(スキャン画像)は抽出結果が空になり同期スキップ+
  警告ログとする。OCR が必要になった時点で、初回のみ Gemini 抽出+抽出結果の
  キャッシュ(md5Checksum 突合)を別 ADR で判断する
- **トレードオフ**: レイアウトの複雑な PDF(多段組・表)は抽出テキストの順序が乱れることが
  ある。ナレッジ用途(意味検索のチャンク)では許容し、精度が問題になった文書は
  .md への書き起こしを推奨する

### ADR-18: エスカレーション解決アクションの実行主体は batch(dashboard は起動のみ)

- **決定**: /admin/escalations の解決アクション(回答送信・裁定・回答不要・再還流)は、
  dashboard から OIDC で起動する batch ジョブ `escalation-action` が実行する。
  dashboard には ops.escalations の書込権限・Chat 送信権限を付与しない。
  解決の種別は `ops.escalations.resolution_type`(ruling / admin_message / no_action)で区別し、
  既存の解決済み行は 'ruling' へバックフィルする(migration 0010)
- **理由**: v0.5 §2 の権限境界の原則(配信の実行主体は batch)を踏襲する。裁定の保存・
  ナレッジ還流は Chat の M6 フローと共通ロジック(shared/escalations.ts へ移動)を使い、
  経路によらず同じ SoT → キャッシュ順序を保証する(原則3・6)
- **整合の担保**: 「メンバーへ回答送信」は adhoc-checkin と同じ「対話レコード作成(SoT)→
  DM 送信 → 失敗時は補償削除」のパターンで、送信できなければエスカレーションを open のまま残す
  (解決済みなのに未回答という不整合を作らない)。解決は open のみ更新(既存裁定を上書きしない)
- **トレードオフ**: ダッシュボードの操作が batch の可用性に依存する(既存の「今すぐ同期」
  「状況確認」と同じ依存。エラーコード AIM-6009 で診断可能)

### ADR-19: 日次 ETL の手動実行は SECURITY DEFINER 関数の実行権限で許可する

- **決定**: `dwh.run_daily_etl` を SECURITY DEFINER(search_path 固定)化し、PUBLIC から
  EXECUTE を剥奪した上で ai_manager_app_rw にのみ付与する。batch の新ジョブ `daily-etl` が
  `SELECT dwh.run_daily_etl($1)` を実行し、/admin/jobs から起動できる。手動実行の既定対象日は
  当日(定時実行の既定は前日のまま)
- **理由**: app_rw へ dwh 表の直接書込+ops/dwh スキーマの CREATE(パーティション作成)を
  付与するより、確定した ETL 一式の実行だけを許可する方が最小権限に適う。関数本文は全参照が
  スキーマ修飾済みで、search_path 乗っ取りの余地がない
- **冪等性**: 対象日のファクトは DELETE→INSERT の洗い替え・fact_workload は UPSERT のため、
  手動実行を何度押しても、また翌日の pg_cron 定時実行と重なっても、集計は巻き戻らない(原則2)
- **トレードオフ**: SECURITY DEFINER は定義者(マイグレーション実行ユーザー)権限で走るため、
  関数の変更レビューでは本文の全参照がスキーマ修飾されていることを確認し続ける必要がある

### ADR-20: 対話フィードバックは decision_rules へ還流し、生ログ閲覧は admin_rw の列外権限で許可する

- **決定**: 管理者フィードバック(v0.12 §7)の SoT は `ops.dialogue_feedback`。
  rag へは `doc_id='feedback/{id}'`・`doc_type='decision_rules'` で還流する(新しい doc_type を
  作らない — 裁定と同じ「判断知識」として検索されることが目的で、QA の検索対象 docTypes を
  変えずに以後の回答へ反映される)。knowledge-sync の掃除は feedback/% を保護する。
  訂正メッセージは dialogue_type='feedback_correction' で対話ログに記録され、
  会話履歴供給(v0.12 §5)を通じて以後の QA 文脈にも入る。
  /admin/dialogues の生ログ閲覧は ai_manager_dashboard_ro には付与せず(要件 7.5 の境界を維持)、
  管理者限定ページ専用の ai_manager_admin_rw に SELECT のみ付与する(アプリ層の管理者判定との二重制御)
- **理由**: ①フィードバックの語彙は裁定と同じ「状況→正しい判断」であり、doc_type を増やすと
  QA・スコープ導出・掃除処理の分岐が増えるだけで検索品質に寄与しない ②生ログは これまで通り
  閲覧ロールから遮断し、管理者の観察補助(要件 3.1)に必要な最小の経路のみ開ける
- **回復経路**: 訂正 DM の送信失敗時はフィードバックが pending のまま残り、画面の「再送」で
  同一 feedback_id から再配信できる(還流も未了なら再試行される)。delivered の再送は拒否
  (二重配信防止・冪等)
- **トレードオフ**: フィードバックが増えると decision_rules の検索空間に混ざる(件数が問題に
  なった時点で doc_type 分離を再検討)。訂正の本人確認(既読)は追わない(送達まで)

## 4. セキュリティ境界の追加

| 経路 | 保護 |
|---|---|
| ブラウザ → dashboard /admin/* | 既存の IAP+role=admin 判定に加え、専用 DB ロール(ai_manager_admin_rw: マスタ4表+顧客の書込可。v0.4 で rag.knowledge_chunks の SELECT、v0.8 で ops.users の列単位権限 — 表示列の SELECT+checkin_enabled のみの UPDATE、v0.9 で ops.projects の SELECT/INSERT/UPDATE と ops.customer_aliases の SELECT/INSERT/DELETE、v0.10 で ops.project_milestones の CRUD と ops.tasks の SELECT+status/updated_at/completed_at 列のみの UPDATE+task_status_log の SELECT/INSERT、v0.12 で ops.dialogues / ops.dialogue_feedback の SELECT(生ログは閲覧ロールに付与しない — ADR-20)— を追加)、CSRF(__Host- クッキー+SameSite=Strict)、全書込の監査ログ。権限の実機検証は scripts/setup/verify-grants.sql |
| dashboard → batch(エスカレーション解決・対話フィードバック・ジョブ手動実行) | 「今すぐ同期」と同じ OIDC ID トークン+Cloud Run IAM+BATCH_INVOKER_SA 照合。加えて batch 側で操作者(operatorUserId)が active な管理者であることを ops.users で検証(多層防御 — ADR-18) |
| dashboard → Drive(ナレッジ投入・削除) | ランタイム SA 自身のトークン(scope: drive。DWD 不使用)。SA が書込めるのは「編集者」で共有されたフォルダのみで、実効権限境界は Drive の共有 ACL(v0.4 §2)。削除はゴミ箱移動(復元可能) |
| dashboard → batch(今すぐ同期) | OIDC ID トークン(audience=batch URL)+Cloud Run IAM(roles/run.invoker)+batch アプリ層の BATCH_INVOKER_SA 照合の多層防御 |
| batch → 本人カレンダー | ドメイン全体委任(calendar.readonly のみ)。SA キー不発行(IAM signJwt)。委任スコープは Workspace 管理者が制御 |
| chat-gateway → タスク起票 | 管理者ロールのみ指示可能。承認カードの操作も role=admin を検証。分解結果は status=proposed で人間の承認が必須(AI は配信しない) |

## 5. 既知の制約(Phase 3 への引き継ぎ)

- dwh の業界分析軸(dim_project.industry)は主業界のみ(多対多の分析軸化は Phase 3 で検討)
- レガシー列 ops.customers.industry は値空間を統一した上で残置(v0.3 §6 の二段階移行。ETL の customer_industries 切替後に削除)
- 顧客マスタの無効化(v0.3 §5)は未対応 — ops.customers に active 列がないため。必要時にスキーマ追加を判断
- タスクの UI 管理は v0.10 でプロジェクト編集ページの「一覧+状態更新」まで実装(ADR-16)。起票・題名・担当・期限の変更は引き続き Chat の動線(M3)が SoT
- 例え話ライブラリの拡充・裁定の Drive 原本反映は運用タスク
- プロジェクトナレッジ(v0.12)の RAG 供給は随時 QA のみ(朝夕対話へは v0.10 の計画情報供給が担う)。対話フィードバックの件数が増えて decision_rules の検索空間を圧迫した場合は doc_type 分離を再検討(ADR-20)
- ターン数上限(v0.12)は定数(朝 11/夕 10)。運用で不足が確認された時点で環境変数化を検討
