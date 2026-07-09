# Phase 2 実装設計

- 上位ドキュメント: [ai-manager-requirements-design.md](../refference/ai-manager-requirements-design.md)(v0.2)+
  [v0.3 追補](../refference/ai-manager-requirements-v0.3-addendum.md)
- 前提: [phase1-implementation.md](./phase1-implementation.md)(ADR-1〜9 は引き続き有効)
- 方針: **全機能を実装し、運用は環境変数/secrets のフラグで段階的に有効化する**(オペレーター判断 2026-07-09)

## 1. 実装スコープ

| モジュール | 状態 | 実装 |
|---|---|---|
| v0.3 マスタ+ナレッジスコープ | **実装済み** | 業界/顧客×業界/関係種別/顧客間関係の4マスタ(migration 0004)、1〜2ホップのスコープ導出(再帰CTE)、RAG 前置フィルタ、knowledge-sync の業界帰属+マスタ突合 |
| v0.3 マスタ管理 UI | **実装済み** | 管理者限定 /admin/*(業界・顧客・関係の CRUD、CSRF 二重送信クッキー __Host-、監査ログ、専用書込ロール ai_manager_admin_rw、未構成時は案内表示) |
| M3 タスクオーケストレーション | **実装済み** | 管理者の指示検知(明示プレフィックス確定+flash-lite 分類)→ pro で分解(subtasks/工数/期限/担当案)→ 承認カード → 担当へ DM 配信 → 対話からの進捗自動更新(着手・完了) |
| M6 異常シグナル検知 | **実装済み** | anomaly-scan バッチ(平日 09:30): 停滞・過負荷・仮説表明率の急落を決定的 SQL+閾値で検知、クールダウン付き起票+管理者通知 |
| M6 裁定ナレッジ還流 | **実装済み** | エスカレーションの「裁定を記録」→ resolution 保存 → decision_rules として rag へ embedding 付き還流(ADR-11) |
| カレンダー連携(M2 拡張) | **実装済み(フラグ)** | ドメイン全体委任(SA キーレス、IAM signJwt)で本人の当日予定を取得し朝の問いかけへ反映 |

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

## 4. セキュリティ境界の追加

| 経路 | 保護 |
|---|---|
| ブラウザ → dashboard /admin/* | 既存の IAP+role=admin 判定に加え、専用 DB ロール(ai_manager_admin_rw: マスタ4表+顧客のみ書込可)、CSRF(__Host- クッキー+SameSite=Strict)、全書込の監査ログ |
| batch → 本人カレンダー | ドメイン全体委任(calendar.readonly のみ)。SA キー不発行(IAM signJwt)。委任スコープは Workspace 管理者が制御 |
| chat-gateway → タスク起票 | 管理者ロールのみ指示可能。承認カードの操作も role=admin を検証。分解結果は status=proposed で人間の承認が必須(AI は配信しない) |

## 5. 既知の制約(Phase 3 への引き継ぎ)

- dwh の業界分析軸(dim_project.industry)は主業界のみ(多対多の分析軸化は Phase 3 で検討)
- レガシー列 ops.customers.industry は値空間を統一した上で残置(v0.3 §6 の二段階移行。ETL の customer_industries 切替後に削除)
- 顧客マスタの無効化(v0.3 §5)は未対応 — ops.customers に active 列がないため。必要時にスキーマ追加を判断
- タスクの一覧・編集 UI はダッシュボード未実装(Chat の動線が SoT。閲覧は既存の負荷マップ/プロジェクトページ)
- 例え話ライブラリの拡充・裁定の Drive 原本反映は運用タスク
