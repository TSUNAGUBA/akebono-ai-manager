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
| v0.8 問いかけ対象のユーザー単位設定 | **実装済み** | ops.users.checkin_enabled(migration 0007。既存行は member=可 / admin=不可で初期化 — 従来動作の保存)。morning/adhoc-checkin の対象クエリと状況確認画面をロール固定からフラグへ変更。管理者限定 /admin/users で可否を切替(監査ログ・CSRF)。ai_manager_admin_rw へ ops.users の列単位 GRANT(ADR-14) |
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

## 4. セキュリティ境界の追加

| 経路 | 保護 |
|---|---|
| ブラウザ → dashboard /admin/* | 既存の IAP+role=admin 判定に加え、専用 DB ロール(ai_manager_admin_rw: マスタ4表+顧客の書込可。v0.4 で rag.knowledge_chunks の SELECT、v0.8 で ops.users の列単位権限 — 表示列の SELECT+checkin_enabled のみの UPDATE — を追加)、CSRF(__Host- クッキー+SameSite=Strict)、全書込の監査ログ |
| dashboard → Drive(ナレッジ投入・削除) | ランタイム SA 自身のトークン(scope: drive。DWD 不使用)。SA が書込めるのは「編集者」で共有されたフォルダのみで、実効権限境界は Drive の共有 ACL(v0.4 §2)。削除はゴミ箱移動(復元可能) |
| dashboard → batch(今すぐ同期) | OIDC ID トークン(audience=batch URL)+Cloud Run IAM(roles/run.invoker)+batch アプリ層の BATCH_INVOKER_SA 照合の多層防御 |
| batch → 本人カレンダー | ドメイン全体委任(calendar.readonly のみ)。SA キー不発行(IAM signJwt)。委任スコープは Workspace 管理者が制御 |
| chat-gateway → タスク起票 | 管理者ロールのみ指示可能。承認カードの操作も role=admin を検証。分解結果は status=proposed で人間の承認が必須(AI は配信しない) |

## 5. 既知の制約(Phase 3 への引き継ぎ)

- dwh の業界分析軸(dim_project.industry)は主業界のみ(多対多の分析軸化は Phase 3 で検討)
- レガシー列 ops.customers.industry は値空間を統一した上で残置(v0.3 §6 の二段階移行。ETL の customer_industries 切替後に削除)
- 顧客マスタの無効化(v0.3 §5)は未対応 — ops.customers に active 列がないため。必要時にスキーマ追加を判断
- タスクの一覧・編集 UI はダッシュボード未実装(Chat の動線が SoT。閲覧は既存の負荷マップ/プロジェクトページ)
- 例え話ライブラリの拡充・裁定の Drive 原本反映は運用タスク
