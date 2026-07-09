# AIマネージャー 要件定義・基本設計ドキュメント

- Version: 0.2 (Draft)
- 更新日: 2026-07-09
- ステータス: 壁打ち結果の集約。Claude Code + GitHub での詳細設計・実装の起点ドキュメント
- 想定リポジトリ配置: `/docs/requirements/ai-manager-requirements-design.md`

## 改訂履歴

| Version | 日付 | 変更内容 |
|---|---|---|
| 0.1 | 2026-07-09 | 初版(Firestore + BigQuery 2ストア構成) |
| 0.2 | 2026-07-09 | データ層を既存 AWS RDS PostgreSQL への一本化に変更。運用系・分析系(スタースキーマ)・ベクトル(pgvector)を単一DBに統合し、クロスクラウド構成(GCP⇔AWS)を明記。同期バッチ(firestore_to_bq)を廃止 |

---

## 0. このドキュメントの位置づけ

社内メンバー(5名)の業務把握・整理・次アクション示唆を担う「AIマネージャー」の要件と基本設計をまとめたもの。
壁打ちで合意した設計思想・ロール定義・機能要件・技術構成・データ設計を、実装フェーズで参照できる粒度で記載する。

以降のフェーズでは本ドキュメントを分割し、以下のドキュメント群に展開することを想定:

```
/docs
  /requirements   … 本書(要件)+ ユースケース詳細
  /architecture   … アーキテクチャ図、ADR(Architecture Decision Records)
  /data           … PostgreSQLスキーマ定義(運用系/DWH/ベクトル)、ETL設計
  /prompts        … エージェントのシステムプロンプト、問いセット、例え話ライブラリ運用
  /operations     … 運用手順、コスト監視、ナレッジ更新フロー
```

---

## 1. 背景と課題認識

### 1.1 会社の現状

- メンバー5名。システム開発・運用を基盤に SaaS 提供と SI 事業を展開
- 主要顧客業界: アパレル小売、アパレルメーカー、雑貨メーカー、寝具メーカー、物流倉庫(SCM関連業務全般)
- 並行プロジェクト: システム関連だけで6社分。うち5社分の企画・提案・開発を社長と副責任者(本ドキュメントでは「管理者」)の2名で担当
- 残り3名は1社分の稼働段取り・最終調整、うつわ事業の在庫管理・店頭調整を担当。現状業務で余裕がない状態
- 1年半前に「AIネイティブ」な業務遂行を決定。社長・管理者の業務効率は極大化したが、他3名は付与済みの有料AIアカウント(ChatGPT/Gemini/Claude)を活用できていない

### 1.2 課題の本質(壁打ちでの合意事項)

- 問題は「ツール活用」ではなく **文脈の非対称性**。事業全体の文脈と判断基準を持つ者がAIを使うとレバレッジが極大化し、持たない者には一般論しか返らない
- 3名に欠けているのは、①ドメイン知識に基づく構造分解力 → ②仮説形成 → ③差分咀嚼のループ。特に①の欠落が起点
- 社長・管理者の仮説検証ループは頭の中で高速に回り外から見えないため、プロセスが学習されない
- 業務過負荷により振り返りの認知的余白がゼロ

### 1.3 目指す姿と現実解

- 理想: 全員が事業全体意識を持ち、適材適所で業務を担う「全員が経営層で実務も担う」チーム
- 現実解(合意済み): 全員一律の引き上げは狙わず **勾配をつける**
  - ③(意志・資質)を持つメンバーには②(仮説形成の反復)を厚く投資
  - ③が薄いメンバーは「AI基盤の上で確実に実行する役割」として高く評価する設計
  - ③の判定は AIマネージャー導入後 3〜6ヶ月、機会を平等に与えた後に行う(導入前判定は誤診リスク)

### 1.4 「強制力」の設計方針

- 報告義務の追加ではなく、**AIを通らないと仕事が進まない動線** を作る
- 本人の作業は増やさず減らす(日報は対話ログから自動生成、ゼロから書く選択肢を消す)
- 監視ツール化させない。評価の自動化はしない(後述の禁止事項参照)

---

## 2. 設計思想(最重要原則)

> **AIマネージャーは「判断する上司」ではなく「文脈を供給し、思考を促し、記録する装置」である。評価と最終判断は人間に残す。**

- AIは提案し記録する。人間は決めて責任を負う
- AIマネージャーの第一目的は「メンバーの管理」ではなく **社長・管理者の頭の中の外部化**(キーパーソンリスク解消とメンバー引き上げを同一施策で実現)
- 可視化データは人事評価の自動化ではなく、管理者の観察を補助するデータであることを社内に明文化する

---

## 3. ユーザーロール定義

### 3.1 ロールA: 管理者ユーザー(社長・管理者の2名)

「AIの上司」。AIマネージャーを育てる責務を持つ。

| 責務 | 内容 |
|---|---|
| ナレッジ供給 | 顧客プロファイル(経緯・キーマン・地雷)、業務知識、業界用語集、過去提案と結果 |
| 判断基準の言語化 | ディシジョンツリー元ネタ。「この状況ならこう判断する、なぜなら〜」形式。例え話ライブラリ含む |
| エスカレーション対応 | AIが判断保留した案件の裁定。**裁定結果は必ずナレッジに還流**(これがAIの成長ループ) |
| 週次キャリブレーション | AI示唆が外れたケースのレビューと判断基準修正 |

- 権限: ナレッジ編集、全ダッシュボード閲覧、タスク指示の承認、エスカレーション裁定
- 運用負荷の見積り: 週2〜3時間。現在の個別ヒアリング時間の置き換えであり、かつ資産として蓄積される

### 3.2 ロールB: 被補佐ユーザー(メンバー3名)

責務は2つのみ:

1. AIの問いに正直に答える
2. AIの提案に対して採用/不採用と理由を返す

- 日報作成・段取り検討・知識調査は責務から外れる(AIが担う)
- 権限: 自分のタスク・対話・個人向け振り返りデータの閲覧。ナレッジは参照のみ

### 3.3 ロールC: AIマネージャー自身の権限境界

**できること(許可)**

- 文脈供給、ドメイン知識の解説、例え話変換
- タスク分解、段取り案・優先順位案の提示
- 問いかけ(仮説形成の促し)、次アクションの一次示唆
- ドラフト作成(提案書・調整メモ等)
- 対話ログからの日報・週報・サマリ自動生成

**できないこと(禁止事項として実装レベルで担保)**

- 人の評価・序列づけ・比較の出力
- 顧客への直接コミット(送信・約束)
- 優先順位の最終決定
- 管理者を経由しない業務指示の変更

---

## 4. 人間とAIの住み分けマトリクス

| 業務 | AI | 人間 |
|---|---|---|
| ドメイン知識の供給・解説 | 全部 | — |
| タスク分解・段取り案 | 案の生成 | 採否 |
| 仮説形成 | 問いと材料の提供 | 仮説の表明(メンバー) |
| 優先順位 | 提案 | 決定(管理者) |
| 顧客対応 | 準備・ドラフト | 実行・コミット |
| 日報・週報 | 自動生成 | 確認のみ |
| 進捗・成長の可視化 | データ生成 | 解釈と評価(管理者のみ) |
| 次アクション示唆 | 一次示唆 | 迷えばエスカレーション裁定 |

### 4.1 AI補完の三層モデル(人材設計の前提)

| 層 | 内容 | AIの関与 |
|---|---|---|
| ① AIが完全代替 | 知識供給、全体像参照、タスク分解、ドキュメント作成、次アクション候補 | 全面移管。本人の暗記・作文能力を不要化 |
| ② AIが足場+本人の反復 | 仮説を立てる、差分咀嚼、判断精度、顧客対話 | 問いと材料の供給。内面化は本人の反復のみ |
| ③ AIでは埋まらない | 当事者意識、知的好奇心、余白を作る意志、意見表明の胆力 | 不可。管理者の観察と処遇設計の領域 |

①の移管により過負荷を除去 → ②③が純粋に露出 → 能力の問題と意志の問題を分離観察できる、という順序で効果が出る。

---

## 5. 機能要件(6モジュール)

### M1. ナレッジベース

- 顧客別プロファイル、業務知識、判断基準集、例え話ライブラリを Google Drive で管理(原本)し、AIが RAG(pgvector)で参照
- 編集権限は管理者のみ。メンバーは参照のみ
- 更新フロー: 管理者が Chat で「これナレッジに入れて」と投げる → AIが構造化して該当 Drive ドキュメントに追記 → 同期バッチでチャンク化・ベクトル化し PostgreSQL へ反映
- ナレッジ文書の標準フォーマット(推奨):
  - `customer/{顧客ID}/profile.md` … 経緯、キーマン、商流、地雷、現行システム
  - `customer/{顧客ID}/glossary.md` … 顧客・業界固有用語
  - `domain/{業界}/operations.md` … 業務フロー解説(例: WMSの種まき/摘み取り)
  - `judgement/decision-rules.md` … 「状況→判断→理由」形式の判断基準集
  - `judgement/analogy-library.md` … 例え話ライブラリ(業務構造→日常事象への転写例)

### M2. デイリー対話エンジン(中核)

思考の型を強制するインターフェース。管理者が行っているソクラテス式壁打ちの自動化。

- **朝(着手時)**: カレンダーとタスク状況を読み、以下を問う
  1. この作業は全体のどこに位置するか
  2. 終わったとき何がどうなっていれば成功か
  3. 予想される引っかかりは何か
  - 答えられない場合、AIがナレッジから文脈を補い一緒に仮説を作る(責めない・穴埋め化させない設計)
- **夕(完了時)**:
  1. 予想と実際の差分は何か
  2. 次に同じ状況が来たら何を変えるか
- **随時**: 質問受付。ドメイン知識解説、「この業務を自分の日常に例えると?」の例え話変換(例え話ライブラリをfew-shotとして利用)
- 対話ログは全件構造化保存(M4/M5の入力)

### M3. タスクオーケストレーション

- 管理者が Chat に指示を投げる → AIが分解・担当案・期限案を提示 → 管理者承認 → メンバーへ配信
- 進捗はメンバーとの対話から自動更新(専用の進捗入力UIは作らない)
- タスクの受け渡しは原則この動線に一本化(「AIを通らないと仕事が進まない」の実装)

### M4. 自動レポーティング

- 日報: 当日の対話ログから自動生成 → 本人は確認ボタンのみ
- 週報(管理者向け): 6社横断の進捗、停滞点、エスカレーション候補のサマリ

### M5. 可視化ダッシュボード

| 対象 | 内容 |
|---|---|
| 全員 | プロジェクト横断の進捗、タスク負荷マップ |
| 管理者限定 | 仮説の表明率と的中傾向、AI提案の採否パターン、問いへの回答の深さの推移(②層の成長と③層の兆候の観察データ) |
| 個人 | 自分の予想と結果の差分履歴(振り返り資産として本人に返す) |

- BIツールから PostgreSQL の DWH スキーマ(集計済みビュー)に接続。管理者限定ビューはDBロール+BIツール側の閲覧権限で二重に制御
- 「評価の自動化ではない」ことを社内向けに明文化

### M6. エスカレーションルーター

以下を検知し管理者へルーティング:

- AIが確信を持てない判断
- 顧客影響のある事項
- メンバーの回答から検知した異常シグナル(停滞、過負荷、回答の質の急落)

裁定結果はナレッジ(judgement/decision-rules.md)へ還流。

---

## 6. システムアーキテクチャ(GCP + AWS クロスクラウド構成)

### 6.1 構成方針

- アプリケーション実行環境とLLMは **GCP**(Google Workspace/Chat/Vertex AI との親和性)
- データベースは **既存の AWS RDS PostgreSQL にデータベースを追加**(限界コストゼロ、既存運用ノウハウの活用)
- 運用データ・スタースキーマ(DWH)・ベクトル(RAG)を **PostgreSQL 1本に統合**。2ストア構成と同期バッチを廃止し、システム全体を単純化

### 6.2 全体構成

```
[Google Chat] ←→ [Chat Gateway (Cloud Run / Cloud Functions 2nd gen)]
                        │
                        ├─→ [Agent Engine 上のマネージャーエージェント]
                        │        ├─ LLM: Vertex AI Gemini (Flash系デフォルト / Pro・Claudeへルーティング)
                        │        ├─ Tools: Calendar / Gmail / Drive / Chat / db_query(RDS) / rag_search(pgvector)
                        │        └─ Embedding: Vertex AI embedding API
                        │
[Cloud Scheduler] ─→ [Cloud Functions] 定時処理(朝の問いかけ / 夕の日報 / 週次サマリ / ナレッジ同期)
                        │
        ═══════ クロスクラウド接続(SSL必須) ═══════
                        │
                  [AWS RDS PostgreSQL]  ※既存インスタンスに database: ai_manager を追加
                        ├─ schema: ops   … 運用データ(タスク、対話、提案、エスカレーション)
                        ├─ schema: dwh   … スタースキーマ(dim/fact)+ 集計ビュー
                        └─ schema: rag   … ナレッジチャンク+ベクトル(pgvector)
                        │
                  [BIツール(Looker Studio 等)] ← dwh の集計ビューに接続
```

### 6.3 クロスクラウド接続設計

| 項目 | 方針 |
|---|---|
| 経路 | GCP側: Cloud Run/Functions に VPC コネクタ + Cloud NAT で **固定エグレスIP** を付与。AWS側: RDS のセキュリティグループでそのIPのみ許可 |
| 暗号化 | RDS への接続は SSL/TLS 必須(`rds.force_ssl` 有効化を推奨) |
| 認証情報 | DB接続情報は **GCP Secret Manager** で管理。アプリには埋め込まない |
| 接続管理 | サーバーレスからの接続数暴発を防ぐため、接続プーリング(アプリ側プール最小化 + 必要に応じ RDS Proxy)を検討 |
| レイテンシ | 東京リージョン同士(asia-northeast1 ⇔ ap-northeast-1)なら実用上問題なし。対話UXへの影響は Phase 1 で実測 |
| 転送コスト | 5ユーザー規模のクエリ・書き込みでは AWS エグレス課金は無視できる水準。ダッシュボードの大量スキャンだけ集計済みビュー参照で抑制 |
| フォールバック | 固定IP方式で要件を満たせない場合の代替: Site-to-Site VPN(ADRとして判断を記録) |

### 6.4 コンポーネント別方針

| レイヤ | 採用 | 理由・備考 |
|---|---|---|
| インターフェース | Google Chat ボット | 新ツールを増やさない(定着の最重要要因) |
| LLM | Vertex AI Gemini Flash系をデフォルト | コスト最小。定型問答・日報生成はFlash / Flash-Lite |
| LLM(高度推論) | Gemini Pro系 or Model Garden経由Claude | 仮説壁打ち・例え話生成・エスカレーション判定のみ振り分け |
| Embedding | Vertex AI embedding API | ナレッジ・対話ログのベクトル化 |
| エージェント | Vertex AI Agent Engine | ツール呼び出し+プランニング。**判断はエージェント、定型はFunctions** |
| 定型フロー | Cloud Functions (2nd gen) / Cloud Run | scale-to-zero。日報生成・朝トリガー等の確定的処理 |
| 定時実行 | Cloud Scheduler | 朝夕・週次トリガー |
| DB(運用/DWH/ベクトル) | AWS RDS PostgreSQL(既存に database 追加) | 限界コストゼロ。pgvector で RAG 同居。トランザクション整合性 |
| DB内バッチ | pg_cron(RDSサポート済み拡張) | ops → dwh の日次変換をDB内で完結 |
| BI | Looker Studio(PostgreSQLコネクタ)等 | dwh の集計ビュー参照。接続方式は Phase 3 で確定 |
| ナレッジ原本 | Google Drive | 管理者の編集体験を既存ツールに寄せる |
| 監査 | Cloud Logging + ops.audit系テーブル | 全対話ログ保全、予算アラート設定 |

### 6.5 モデルルーティング方針(コスト最適化の中核)

```
リクエスト分類:
  - 定型(挨拶、進捗確認、日報生成、要約)          → Gemini Flash-Lite / Flash
  - 知識回答(RAG参照のドメイン解説)               → Gemini Flash + rag_search
  - 思考支援(仮説壁打ち、例え話生成、差分分析)     → Gemini Pro(必要に応じ Claude)
  - 判断保留検知・エスカレーション判定              → Gemini Pro
```

- 分類自体は Flash-Lite かルールベース(キーワード+コンテキスト種別)で行い、分類コストを最小化
- context caching を活用(システムプロンプト+顧客プロファイルの固定部分をキャッシュ)

---

## 7. データ層設計(PostgreSQL 一本化)

### 7.1 設計方針

- 既存 RDS インスタンスに **database `ai_manager` を新設**し、既存業務DBと論理分離。専用のDBユーザー(アプリ用/BI閲覧用/管理用)を発行
- 単一DB内を3スキーマに分割: **ops(運用)/ dwh(分析・スタースキーマ)/ rag(ベクトル)**
- ops → dwh の変換は **pg_cron による夜間SQLバッチ**(クロスストア同期が不要になったため、ETLはDB内のINSERT...SELECTで完結)
- 分析要件はスタースキーマで担保し、AI参照は pgvector で担保。**「分析のためのスタースキーマ化」と「AIのためのベクトル化」を同一DBで実現**
- 前提確認事項: 既存RDSのPostgreSQLバージョン(pgvector は 15.2 以降で標準サポート)、pg_cron 有効化可否、本番業務DBとの同居によるリソース競合(Phase 1 で監視し、問題があれば専用小型インスタンスへ分離)

### 7.2 ops スキーマ(運用系)DDL

```sql
CREATE SCHEMA ops;

CREATE TABLE ops.users (
  user_id        TEXT PRIMARY KEY,            -- Google Workspace のユーザーID
  display_name   TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  chat_space_id  TEXT,                        -- DMスペースID
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.customers (
  customer_id               TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  industry                  TEXT NOT NULL CHECK (industry IN
    ('apparel_retail','apparel_maker','zakka','bedding','logistics','other')),
  knowledge_drive_folder_id TEXT,
  notes                     TEXT
);

CREATE TABLE ops.projects (
  project_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  customer_id    TEXT REFERENCES ops.customers(customer_id),
  project_type   TEXT NOT NULL CHECK (project_type IN
    ('si','saas','media','utsuwa','internal')),
  status         TEXT NOT NULL DEFAULT 'active',
  priority       INT,
  admin_owner_id TEXT REFERENCES ops.users(user_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.tasks (
  task_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        TEXT REFERENCES ops.projects(project_id),
  title             TEXT NOT NULL,
  description       TEXT,
  assignee_id       TEXT REFERENCES ops.users(user_id),
  requester_id      TEXT REFERENCES ops.users(user_id),  -- 指示した管理者
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','approved','in_progress','blocked','done','cancelled')),
  ai_decomposition  JSONB,      -- { subtasks: [], estimated_hours, suggested_deadline }
  approved_by       TEXT REFERENCES ops.users(user_id),
  due_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX idx_tasks_assignee_status ON ops.tasks (assignee_id, status);
CREATE INDEX idx_tasks_project ON ops.tasks (project_id);

-- タスク状態遷移の履歴(fact_task_activity の源泉)
CREATE TABLE ops.task_status_log (
  log_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      BIGINT NOT NULL REFERENCES ops.tasks(task_id),
  status_from  TEXT,
  status_to    TEXT NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_via  TEXT NOT NULL DEFAULT 'dialogue'  -- dialogue / admin / system
);

CREATE TABLE ops.dialogues (
  dialogue_id    BIGINT GENERATED ALWAYS AS IDENTITY,
  user_id        TEXT NOT NULL REFERENCES ops.users(user_id),
  task_id        BIGINT,
  project_id     TEXT,
  dialogue_type  TEXT NOT NULL CHECK (dialogue_type IN
    ('morning_checkin','completion_review','adhoc_qa','task_instruction','escalation')),
  turns          JSONB NOT NULL DEFAULT '[]',
    -- [ { role: 'ai'|'user', content, ts } ]
  hypothesis     JSONB,
    -- { position, success_criteria, expected_obstacles, ai_assisted: bool }
  review         JSONB,
    -- { actual_outcome, gap_analysis, next_change }
  model_used     TEXT,
  input_tokens   INT,
  output_tokens  INT,
  cost_usd       NUMERIC(10,6),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dialogue_id, created_at)
) PARTITION BY RANGE (created_at);
-- 月次パーティションを pg_cron / partman で自動作成
CREATE INDEX idx_dialogues_user_date ON ops.dialogues (user_id, created_at);

CREATE TABLE ops.suggestions (
  suggestion_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dialogue_id      BIGINT,
  user_id          TEXT NOT NULL REFERENCES ops.users(user_id),
  task_id          BIGINT,
  content          TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN
    ('next_action','decomposition','priority','knowledge')),
  user_decision    TEXT CHECK (user_decision IN
    ('accepted','rejected','modified','ignored')),
  decision_reason  TEXT,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.escalations (
  escalation_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reason              TEXT NOT NULL CHECK (reason IN
    ('low_confidence','customer_impact','member_anomaly','priority_conflict')),
  context             TEXT NOT NULL,
  related_task_id     BIGINT,
  related_user_id     TEXT REFERENCES ops.users(user_id),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution          TEXT,
  resolved_by         TEXT REFERENCES ops.users(user_id),
  resolved_at         TIMESTAMPTZ,
  knowledge_reflected BOOLEAN NOT NULL DEFAULT FALSE,  -- ナレッジ還流済みフラグ
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.reports (
  report_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type        TEXT NOT NULL CHECK (report_type IN ('daily','weekly_admin')),
  user_id            TEXT REFERENCES ops.users(user_id),
  report_date        DATE NOT NULL,
  content            TEXT NOT NULL,
  confirmed_by_user  BOOLEAN NOT NULL DEFAULT FALSE,
  source_dialogue_ids BIGINT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_type, user_id, report_date)
);
```

### 7.3 dwh スキーマ(スタースキーマ)DDL

データ量が小さいうちは「ビューで足りるのでは」という論点があるが、**②層の成長観察(仮説→結果の突合)は時点スナップショットの蓄積が本質**であり、履歴を持つファクトテーブルとして実体化する。SCD Type 2 のディメンションも役割変更の履歴分析に必要。

```sql
CREATE SCHEMA dwh;

-- ── ディメンション ──────────────────────────

CREATE TABLE dwh.dim_user (
  user_key     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  active       BOOLEAN NOT NULL,
  valid_from   DATE NOT NULL,
  valid_to     DATE NOT NULL DEFAULT '9999-12-31'   -- SCD Type 2
);
CREATE INDEX idx_dim_user_nk ON dwh.dim_user (user_id, valid_to);

CREATE TABLE dwh.dim_project (
  project_key   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  project_type  TEXT NOT NULL,
  customer_id   TEXT,
  customer_name TEXT,
  industry      TEXT,
  status        TEXT NOT NULL,
  valid_from    DATE NOT NULL,
  valid_to      DATE NOT NULL DEFAULT '9999-12-31'
);

CREATE TABLE dwh.dim_date (
  date_key        INT PRIMARY KEY,        -- YYYYMMDD
  full_date       DATE NOT NULL UNIQUE,
  year            INT NOT NULL,
  quarter         INT NOT NULL,
  month           INT NOT NULL,
  week_of_year    INT NOT NULL,
  day_of_week     INT NOT NULL,
  is_business_day BOOLEAN NOT NULL
);
-- generate_series で10年分を初期投入

CREATE TABLE dwh.dim_task_type (
  task_type_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      TEXT NOT NULL,   -- development / proposal / operation / adjustment / inventory ...
  subcategory   TEXT
);

CREATE TABLE dwh.dim_dialogue_type (
  dialogue_type_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dialogue_type     TEXT NOT NULL UNIQUE
);

-- ── ファクト ────────────────────────────────

-- タスク状態遷移粒度
CREATE TABLE dwh.fact_task_activity (
  task_activity_key BIGINT GENERATED ALWAYS AS IDENTITY,
  date_key          INT NOT NULL REFERENCES dwh.dim_date(date_key),
  user_key          BIGINT REFERENCES dwh.dim_user(user_key),
  project_key       BIGINT REFERENCES dwh.dim_project(project_key),
  task_type_key     BIGINT REFERENCES dwh.dim_task_type(task_type_key),
  task_id           BIGINT NOT NULL,
  status_from       TEXT,
  status_to         TEXT NOT NULL,
  lead_time_hours   NUMERIC(10,2),
  estimated_hours   NUMERIC(10,2),
  was_blocked       BOOLEAN,
  PRIMARY KEY (task_activity_key, date_key)
) PARTITION BY RANGE (date_key);

-- 対話1セッション粒度
CREATE TABLE dwh.fact_dialogue (
  dialogue_key           BIGINT GENERATED ALWAYS AS IDENTITY,
  date_key               INT NOT NULL,
  user_key               BIGINT NOT NULL,
  project_key            BIGINT,
  dialogue_type_key      BIGINT NOT NULL,
  turn_count             INT NOT NULL,
  user_response_chars    INT,        -- 回答の量(深さの代理指標の一つ)
  hypothesis_stated      BOOLEAN,    -- 本人が仮説を表明したか
  hypothesis_ai_assisted BOOLEAN,    -- AI補助で仮説化したか
  review_completed       BOOLEAN,
  model_used             TEXT,
  input_tokens           INT,
  output_tokens          INT,
  cost_usd               NUMERIC(10,6),
  PRIMARY KEY (dialogue_key, date_key)
) PARTITION BY RANGE (date_key);

-- 仮説→結果の突合粒度(②層の成長観察の中核)
CREATE TABLE dwh.fact_hypothesis_outcome (
  hypothesis_key      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key            INT NOT NULL,          -- 仮説表明日
  user_key            BIGINT NOT NULL,
  project_key         BIGINT,
  task_id             BIGINT,
  hypothesis_text     TEXT,
  outcome_text        TEXT,
  gap_category        TEXT CHECK (gap_category IN ('none','minor','major','opposite')),
    -- AIが分類
  next_change_stated  BOOLEAN,               -- 「次に変えること」を言語化できたか
  days_to_outcome     INT
);

-- AI提案の採否粒度
CREATE TABLE dwh.fact_ai_suggestion (
  suggestion_key         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key               INT NOT NULL,
  user_key               BIGINT NOT NULL,
  project_key            BIGINT,
  category               TEXT NOT NULL,
  decision               TEXT,               -- accepted / rejected / modified / ignored
  decision_reason_stated BOOLEAN,
  hours_to_decision      NUMERIC(10,2)
);

-- 日次スナップショット粒度
CREATE TABLE dwh.fact_workload (
  date_key           INT NOT NULL,
  user_key           BIGINT NOT NULL,
  open_tasks         INT NOT NULL,
  in_progress_tasks  INT NOT NULL,
  blocked_tasks      INT NOT NULL,
  overdue_tasks      INT NOT NULL,
  checkin_completed  BOOLEAN NOT NULL,       -- 朝の問答実施
  review_completed   BOOLEAN NOT NULL,       -- 夕の問答実施
  PRIMARY KEY (date_key, user_key)
);

CREATE TABLE dwh.fact_escalation (
  escalation_key      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key            INT NOT NULL,
  raised_reason       TEXT NOT NULL,
  related_user_key    BIGINT,
  related_project_key BIGINT,
  hours_to_resolve    NUMERIC(10,2),
  knowledge_reflected BOOLEAN                -- ナレッジ還流率のKPI元
);
```

#### ETL(ops → dwh)

- **pg_cron で毎日深夜に実行**する SQL バッチ(INSERT ... SELECT ... ON CONFLICT)。差分抽出は各 ops テーブルの `created_at` / `changed_at` を基準に前日分を取り込む
- `fact_workload` は日次スナップショットとして tasks の現在状態を集計
- `fact_hypothesis_outcome` は dialogues の hypothesis(朝)と review(夕)を task_id で突合し、gap_category は夕バッチ内で LLM 分類(Flash)した結果を ops 側に書き戻してから取り込む
- ディメンションの SCD Type 2 更新(users / projects の変更検知→現行行の valid_to クローズ+新行追加)も同バッチ内で実施

#### 主要KPI(ダッシュボード用ビュー)

```sql
-- 管理者限定ビューの例(BI閲覧用DBロールに dwh の集計ビューのみ GRANT)
CREATE VIEW dwh.v_member_growth AS ...      -- 仮説表明率、AI補助率推移、gap分布推移、next_change言語化率
CREATE VIEW dwh.v_suggestion_pattern AS ... -- 提案採否率、理由言語化率(メンバー別・カテゴリ別)
CREATE VIEW dwh.v_project_health AS ...     -- プロジェクト別 lead_time、blocked率、overdue率
CREATE VIEW dwh.v_ai_cost AS ...            -- 日次・ユーザー別・モデル別コスト
CREATE VIEW dwh.v_knowledge_loop AS ...     -- エスカレーション件数とナレッジ還流率
```

### 7.4 rag スキーマ(ベクトル)設計

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA rag;

-- ナレッジ文書チャンク
CREATE TABLE rag.knowledge_chunks (
  chunk_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id       TEXT NOT NULL,          -- Drive fileId
  doc_type     TEXT NOT NULL CHECK (doc_type IN
    ('customer_profile','glossary','domain_ops','decision_rules','analogy')),
  customer_id  TEXT,
  title        TEXT,
  chunk_index  INT NOT NULL,
  chunk_text   TEXT NOT NULL,
  embedding    vector(768),            -- Vertex AI embedding の次元数に合わせて確定
  content_hash TEXT NOT NULL,          -- 差分同期用
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index)
);
CREATE INDEX idx_knowledge_hnsw ON rag.knowledge_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_knowledge_filter ON rag.knowledge_chunks (doc_type, customer_id);

-- 過去対話の要約ベクトル(「過去の類似ケース」参照用)
CREATE TABLE rag.dialogue_embeddings (
  dialogue_id  BIGINT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  embedding    vector(768),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dialogue_emb_hnsw ON rag.dialogue_embeddings
  USING hnsw (embedding vector_cosine_ops);
```

| 対象 | フロー |
|---|---|
| ナレッジ文書(Drive) | Cloud Functions で日次+更新検知同期 → 見出し単位チャンク分割(500〜1000字、オーバーラップ100字)→ content_hash 比較で差分のみ Vertex AI embedding → UPSERT |
| 過去対話ログ | 夕次バッチで dialogue 要約を生成(Flash)→ ベクトル化 → dialogue_embeddings へ |
| 判断基準・例え話 | ナレッジと同フロー。doc_type で分離し、例え話生成時の few-shot 検索に使用 |
| 検索 | `embedding <=> $query` のコサイン距離 + doc_type/customer_id の事前フィルタ。数千チャンク規模なら HNSW で数ms |

### 7.5 データライフサイクル・権限

- パーティション: dialogues / fact系は月次レンジパーティション(pg_cron で自動作成・アーカイブ)
- 保持: 全履歴保持(小規模のため削除運用は当面不要)。生の対話ログは Cloud Logging 30日 + ops.dialogues 恒久
- DBユーザー分離:
  - `app_rw` … ops / rag の読み書き、dwh は書き込みのみ(ETL)
  - `bi_ro` … dwh の集計ビューのみ SELECT(管理者限定ビューはさらに別ロール)
  - `admin` … 全権(スキーマ変更・pg_cron 管理)
- 個人の差分履歴(fact_hypothesis_outcome)は本人に開示(振り返り資産)

---

## 8. アプリケーション構造(リポジトリ設計)

```
ai-manager/
├── docs/                        # 本ドキュメント群
├── packages/
│   ├── chat-gateway/            # Google Chat App(Cloud Run / Functions)
│   │   ├── src/
│   │   │   ├── handlers/        # Chatイベントハンドラ(message, card action)
│   │   │   ├── router.ts        # リクエスト分類 → agent or 定型フロー振り分け
│   │   │   └── auth.ts          # ユーザー識別・ロール解決
│   ├── agent/                   # Agent Engine デプロイ物
│   │   ├── src/
│   │   │   ├── agent.py         # エージェント定義(ADK想定)
│   │   │   ├── tools/           # calendar / gmail / drive / db_query / rag_search
│   │   │   ├── prompts/         # システムプロンプト、問いセット、禁止事項
│   │   │   └── routing.py       # モデルルーティング(Flash/Pro/Claude)
│   ├── batch/                   # Cloud Functions(定型・定時)
│   │   ├── morning_checkin/     # 朝の問いかけ配信
│   │   ├── daily_report/        # 日報生成
│   │   ├── weekly_summary/      # 週次管理者サマリ
│   │   └── knowledge_sync/      # Drive→チャンク→embedding→rag スキーマ UPSERT
│   ├── db/                      # マイグレーション(ops/dwh/rag のDDL、pg_cron ジョブ定義)
│   │   ├── migrations/
│   │   └── etl/                 # ops→dwh 変換SQL(pg_cron から実行)
│   ├── shared/                  # 型定義、DB接続(プール)、定数
│   └── dashboard/               # BIツール定義のエクスポート、dwh ビューDDL
├── infra/                       # Terraform(GCPリソース、VPCコネクタ/NAT、Secret、Scheduler、予算アラート
│                                #   + AWS側: RDSセキュリティグループ、DBユーザーは手順書管理でも可)
├── .github/workflows/           # CI/CD(lint, test, migrate, deploy)
```

- 言語: chat-gateway / batch は TypeScript(Node.js)、agent は Python(ADK/Agent Engineの成熟度優先)を想定。Claude Codeでの詳細設計時に確定
- マイグレーションツール(Flyway / Drizzle / Prisma 等)は未決事項
- IaC: GCP側はTerraformで全リソース管理(再現性とマルチテナント転用=将来のSaaS化を見据える)

---

## 9. コスト方針

### 9.1 原則

1. **常時起動リソースを新設しない**: Cloud Run / Functions は min-instances=0。DBは既存RDSへの同居で **限界コストゼロ**
2. **LLMはFlash系デフォルト**: Pro/Claudeは思考支援とエスカレーション判定のみ。context cachingで固定プロンプトのコスト削減
3. **クロスクラウド転送は集計済みビュー参照で最小化**: BI・エージェントとも生ログの大量スキャンをしない
4. **予算アラート**: GCPプロジェクトに月額上限アラート(段階 50%/80%/100%)。`dwh.v_ai_cost` で日次監視
5. RDSのリソース競合を監視し、既存業務への影響が出た場合のみ分離を検討(その時点で初めて固定費が発生)

### 9.2 概算(5ユーザー、Phase 2到達時の目安)

| 項目 | 月額目安 |
|---|---|
| Gemini Flash系(日次対話・日報) | 数百円〜2千円程度 |
| Gemini Pro / Claude(思考支援) | 1〜3千円程度 |
| Embedding(ナレッジ+対話ログ) | 数百円 |
| RDS(既存インスタンスにDB追加) | 0円(既存費用に内包) |
| AWSエグレス(クロスクラウド転送) | 無視できる水準(〜数十円) |
| Cloud Run / Functions / Scheduler / NAT | ほぼ無料枠内〜数百円(NATは微少な従量費あり) |
| **合計** | **月数千円オーダー** |

※実測に基づき Phase 1 で fact_dialogue の cost_usd を集計し、早期に精緻化する。

---

## 10. 段階導入計画

### Phase 1(〜1ヶ月): 対話と日報

- スコープ: M2(朝夕の対話)+ M4の日報のみ
- ナレッジ: 主要1〜2社分だけ投入(完璧を目指さない。対話ログが「何をナレッジ化すべきか」を教える)
- 構成: Chatボット + Gemini Flash + RDSに ai_manager DB新設(ops / rag スキーマのみ。dwh は Phase 3 でも可だが、ops の履歴設計だけは初日から正しく)
- インフラ検証項目: クロスクラウド接続(固定IP+SSL)、対話レイテンシ実測、既存RDSへの負荷影響
- 判定基準: メンバーの対話継続率、回答の質、日報の確認率

### Phase 2: オーケストレーションとエスカレーション

- M3 + M6 を追加。ナレッジを6社分へ拡張
- タスク受け渡しのAI動線一本化を開始
- 管理者の週次キャリブレーション運用を定着させる

### Phase 3: 可視化と判定

- dwh スキーマ構築 + pg_cron ETL + M5ダッシュボード(BIツール接続)
- ここで初めて三層モデル③の判定材料が揃う(導入後3〜6ヶ月時点)
- 判定と処遇設計(勾配)の実施

---

## 11. 非機能要件

| 項目 | 要件 |
|---|---|
| 認証 | Google Workspace アカウントに一本化。Chat AppはWorkspace内限定公開 |
| 認可 | ロール(admin/member)は ops.users で管理。DWHの管理者限定ビューはDBロール+BIツール閲覧権限で二重制御 |
| 秘匿情報 | RDS接続情報は GCP Secret Manager。SSL/TLS必須、固定エグレスIPによるセキュリティグループ制限 |
| 監査 | 全対話・全AI提案・全裁定をDB保全 + Cloud Logging |
| プライバシー | 成長可視化データの用途を「管理者の観察補助」と社内規程に明文化。個人差分履歴は本人開示 |
| 可用性 | 業務時間帯のベストエフォート。Chat応答不能時はAIを介さない通常業務にフォールバック可能とする(初期は厳格なSLO不要) |
| データ保護 | 既存RDSのバックアップ運用(自動スナップショット)に ai_manager DB も内包されることを確認 |
| 拡張性 | マルチテナント化(将来のSaaS転用)を阻害しない設計: tenant_id をスキーマに予約、PostgreSQL RLS の適用余地を残す、IaC管理 |

---

## 12. リスクと対策

| リスク | 対策 |
|---|---|
| 監視ツール化してメンバーが萎縮 | 禁止事項の実装担保、可視化データの用途明文化、日報等で本人の作業を「減らす」体験を先に届ける |
| 問答の穴埋め作業化 | 回答の質低下をM6が検知→管理者へ。答えられない時はAIが補って一緒に作る設計(責めない) |
| 管理者のナレッジ供給が続かない | Chat経由の口語投入→AI構造化のフローで摩擦最小化。エスカレーション裁定の還流を必須フロー化 |
| コスト超過 | モデルルーティング、予算アラート、v_ai_costでの日次監視 |
| AIの示唆が的外れで信頼失墜 | Phase 1は対象ナレッジを絞り確度を上げる。確信が持てない時は「わからない」と言わせエスカレーション |
| キーパーソンリスクの残存 | 裁定・判断基準のナレッジ還流率(fact_escalation.knowledge_reflected)をKPI化 |
| 既存RDSへの負荷影響 | 別database+専用ユーザーで分離、Phase 1で負荷監視、影響時は専用小型インスタンスへ移設(移行はpg_dumpで容易) |
| クロスクラウド接続の不安定・設定ミス | 固定IP+SSL+Secret Managerを標準化しTerraform/手順書化。接続断時はChat側でリトライ+管理者通知 |
| サーバーレスからの接続数暴発 | アプリ側プール最小化、必要に応じ RDS Proxy 導入 |

---

## 13. 未決事項(Claude Codeでの詳細設計で確定)

- [ ] 既存RDSの PostgreSQL バージョン確認(pgvector は 15.2+、pg_cron 有効化可否)
- [ ] クロスクラウド接続方式の最終確定(固定エグレスIP+SG許可 vs Site-to-Site VPN)→ ADR化
- [ ] RDS Proxy の要否(Phase 1 の接続数実測後)
- [ ] マイグレーションツールの選定(Flyway / Drizzle / Prisma 等)
- [ ] Embedding モデルと次元数の確定(vector(768) は仮置き)
- [ ] agent実装のフレームワーク確定(ADK / LangGraph 等)と言語
- [ ] 朝夕の問いセットの具体文言とトーン設計(プロンプト設計フェーズ)
- [ ] 例え話ライブラリの初期データ作成(管理者の過去事例の棚卸し)
- [ ] Drive ナレッジのチャンク戦略の実測チューニング
- [ ] Model Garden経由Claude利用の要否判断(Phase 1はGeminiのみで開始し比較検証)
- [ ] Chat App のカードUI設計(確認ボタン、採否ボタン等)
- [ ] BIツールの最終確定(Looker Studio の PostgreSQL 接続方式の検証、代替として Metabase 等)
- [ ] tenant_id 設計の詳細(SaaS転用時のデータ分離方式、RLS適用)
- [ ] 社内規程(可視化データの用途)の文面

---

## 付録A. 用語

| 用語 | 定義 |
|---|---|
| 管理者 | 社長および本プロジェクト責任者。ロールA |
| メンバー | 被補佐ユーザー3名。ロールB |
| 三層モデル | ①AI完全代替 / ②AI足場+本人反復 / ③本人の意志・資質 の切り分け |
| ナレッジ還流 | エスカレーション裁定や判断結果を判断基準集へ書き戻すループ |
| 例え話ライブラリ | 業務構造を日常事象へ転写した説明例の集積(例: 種まきリスト=給食配膳、摘み取りリスト=ビュッフェ) |
| ops / dwh / rag | ai_manager DB内の3スキーマ。運用系 / スタースキーマ(分析) / ベクトル(RAG) |

## 付録B. v0.1 からのアーキテクチャ変更判断(ADR要約)

- **決定**: Firestore + BigQuery の2ストア構成を廃し、既存 AWS RDS PostgreSQL への一本化を採用
- **理由**: 既存RDSへのDB追加は限界コストゼロ。運用・分析・ベクトルが単一DBに収まり同期バッチが不要になる。トランザクション整合性、pgvector、将来のRLSによるマルチテナント化と相性が良い
- **トレードオフ**: クロスクラウド接続(GCP⇔AWS)の設計・運用が一点増える。BigQueryの無料枠(月10GBストレージ+1TBクエリ)を捨てるが、この規模ではどちらもほぼゼロ円のため簡潔さを優先
- **再検討条件**: データ肥大により分析クエリがRDSを圧迫した場合、分析系のみBigQueryへ切り出す(Postgresを正とした片方向連携)
