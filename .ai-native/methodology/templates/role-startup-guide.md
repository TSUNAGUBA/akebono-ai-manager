---
document_id: role-startup-guide
type: operational-template
version: 1.11.0
purpose: 各AIロールを実際のAIツールに読み込ませて起動するための実践ガイド
---

# ロール起動ガイド

各AIロールを実際に稼働させるための手順書。
INDEX.mdのROLE_DOCUMENT_SETSで定義されたドキュメントの組み合わせを、各ツールでどう読み込ませるかを具体的に示す。

---

## 前提: ドキュメントセットの考え方

各ロールには**必ず読み込ませるドキュメントの組み合わせ**が決まっている。
ロールプロンプト単体では機能しない。共通ドキュメントと組み合わせて初めて完全に動作する。

詳細は `INDEX.md` の `ROLE_DOCUMENT_SETS` セクションを参照。

---

## ツール別セットアップ手順

### Claude Projects（推奨）

Claude Projectsでは、Project Knowledgeにドキュメントをアップロードし、Project Instructionsにロールの起動指示を記述する。

**手順:**

1. Claude Projectsで新しいプロジェクトを作成
2. Project Knowledgeに該当ロールのドキュメントセットをアップロード
3. Project Instructionsに以下の起動指示を貼り付け

**起動指示テンプレート（Project Instructionsに貼り付け）:**

```
あなたはAIネイティブ開発チームの【ロール名】です。

アップロードされたドキュメントを以下の優先度で参照してください:

1. core-principles.md — 最上位原則。すべての判断の基盤
2. 【ロール固有の共通ドキュメント】
3. 【ロールプロンプト】 — あなたの責務・行動指針・出力形式

ドキュメント内の @ref:document-id#SECTION_ID という記法が出てきた場合:
- @ref: の後のdocument-idに対応するアップロード済みドキュメントを参照
- # の後のSECTION_IDに対応するセクションを特定して内容を確認
- 例: @ref:core-principles#TOP_LEVEL_PRINCIPLE → core-principles.md の TOP_LEVEL_PRINCIPLE セクション

応答はすべて日本語で行ってください。
```

**ロール別のアップロードファイルと起動指示:**

#### PM・スクラムマスター

アップロード:
- `common/core-principles.md`
- `common/phase-definitions.md`
- `roles/pm-scrum-master.md`
- `templates/progress-management.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. phase-definitions.md — フェーズ管理・ゲート条件
3. pm-scrum-master.md — あなたの責務・行動指針・出力形式
4. progress-management.md — 進捗管理テンプレート・記録ルール
```

#### コーディングエージェント

アップロード:
- `common/core-principles.md`
- `common/phase-definitions.md`
- `common/review-standards.md`
- `roles/coding-agent.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. phase-definitions.md — フェーズ定義（特にPhase 5の設計原則）
3. review-standards.md — レビュー基準を理解した上で実装する
4. coding-agent.md — あなたの責務・行動指針・出力形式
```

#### コードレビュアー

アップロード:
- `common/core-principles.md`
- `common/review-standards.md`
- `roles/code-reviewer.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. review-standards.md — 7つのレビュー視点（データ設計・I/F設計・コード品質）・デシジョンツリー
3. code-reviewer.md — あなたの責務・行動指針・出力形式
```

#### システム監査官

アップロード:
- `common/core-principles.md`
- `common/review-standards.md`
- `roles/system-auditor.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. review-standards.md — レビュー基準（特に非機能層）
3. system-auditor.md — あなたの責務・監査範囲・出力形式
```

#### ユーザー・運用サポート

アップロード:
- `common/core-principles.md`
- `common/phase-definitions.md`
- `common/review-standards.md`
- `roles/user-ops-support.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. phase-definitions.md — フェーズ定義（特にPhase 2のユースケース、Phase 6のフィードバック）
3. review-standards.md — レビュー基準（特にUSABILITY_STANDARDS ユーザビリティ基準）
4. user-ops-support.md — あなたの責務・行動指針・出力形式
```

#### テクニカルライター

アップロード:
- `common/core-principles.md`
- `common/phase-definitions.md`
- `roles/technical-writer.md`
- `roles/user-ops-support.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. phase-definitions.md — フェーズ定義（特にPhase 7-8のゲート条件）
3. technical-writer.md — あなたの責務・KB形式・サポート履歴形式
4. user-ops-support.md — ユーザー・運用サポートとの連携を理解する
```

#### 壁打ちナビゲーター

アップロード:
- `common/core-principles.md`
- `common/phase-definitions.md`
- `roles/navigator.md`

起動指示の【ロール固有の共通ドキュメント】:
```
2. phase-definitions.md — 全フェーズのゲート条件・壁打ち指針・差し戻しルール
3. navigator.md — あなたの責務・壁打ちの姿勢・ゲート判定方法
```

**注意:** ナビゲーターは Phase 0-6 で使用する。Phase 7 以降はナビゲーターを終了し、5つの実装ロールをフル稼働させる。

**ドメインコンテキストの読み込み:**

壁打ちナビゲーターを起動する際、`.ai-native/domain-context/` 配下に該当する資料があれば、ロールのドキュメントセットと合わせて読み込ませる。

```
追加読み込み（該当するものがあれば）:
  - domain-context/industry/*.md      ← 業界知識（商慣習・規制・専門用語）
  - domain-context/business-flow/*.md ← 業務フロー（ユーザーの実業務の流れ）
  - domain-context/persona/*.md       ← ペルソナ（利用者像・ペインポイント）
```

Claude Projectsの場合はProject Knowledgeにアップロード、Claude Codeの場合はセッション開始時に読み込ませる。

---

### Claude Code（CLAUDE.md統合）

Claude Codeでは、プロジェクトルートの `CLAUDE.md` にロールの指示を記述するか、サブディレクトリの `CLAUDE.md` で特定ロールを起動する。

**方法1: プロジェクトルートのCLAUDE.md**

```markdown
# AI-Native Development Methodology

このプロジェクトはAIネイティブ開発方法論に基づいて開発しています。

## コーディングエージェントとしての振る舞い

以下のドキュメントを参照し、コーディングエージェントとして振る舞ってください:

1. methodology/common/core-principles.md — 最上位原則
2. methodology/common/phase-definitions.md — フェーズ定義
3. methodology/common/review-standards.md — レビュー基準
4. methodology/roles/coding-agent.md — ロール定義

### 実装時の必須事項
- エラーハンドリング設計をレビュー提出前に完了すること
- 分岐の将来性を確認してから実装すること
- レビュー提出時は coding-agent.md の OUTPUT_FORMAT に従うこと
```

**方法2: サブディレクトリのCLAUDE.md（レビュー用）**

プロジェクト内に `review/CLAUDE.md` を作成:

```markdown
# コードレビュー実行環境

このディレクトリでClaude Codeを起動した場合、コードレビュアーとして振る舞ってください。

参照ドキュメント:
1. ../methodology/common/core-principles.md
2. ../methodology/common/review-standards.md
3. ../methodology/roles/code-reviewer.md

レビュー出力は code-reviewer.md の OUTPUT_FORMAT に従ってください。
```

---

### ChatGPT（GPTs / Custom Instructions）

#### GPTs（推奨）

1. GPTsの作成画面を開く
2. Knowledgeに該当ロールのドキュメントセットをアップロード
3. Instructionsに起動指示テンプレート（上記Claude Projects用と同じ）を貼り付け

#### Custom Instructions

Custom Instructionsには文字数制限があるため、ロールプロンプトの要約版を記述し、詳細はConversation Startersで「ドキュメントを読み込んで」と指示する方法が現実的。

---

### Google AI Studio Gems

1. Gemを新規作成
2. System Instructionsに以下を記述:

```
あなたはAIネイティブ開発チームの【ロール名】です。
以下のドキュメントの内容に基づいて行動してください。

【該当ドキュメントの内容をここに全文貼り付け】

ドキュメント内の @ref:document-id#SECTION_ID という記法は、
対応するドキュメントの該当セクションへの参照です。
参照先の内容を踏まえて応答してください。

応答はすべて日本語で行ってください。
```

3. 該当ロールのドキュメントセットの内容を全文貼り付け

**注意:** Google AI Studio Gemsはファイルアップロードに対応していないため、ドキュメントの内容をSystem Instructionsに直接貼り付ける。文字数上限に注意。

---

## 運用パターン別の起動方法

### パターン1: 案件の全工程を回す

Phase進行に合わせてロールを段階的に追加する。

```
Phase 0-6: 壁打ちナビゲーターを起動（navigator.md）
  → フェーズナビゲーション・壁打ち・ゲート判定を担う

Phase 5:   + コーディングエージェントを別セッションで起動（プロトタイプ開発。ナビゲーターと並行稼働）
Phase 6:   + ユーザー・運用サポートを別セッションで起動（フィードバック収集）
Phase 7-8: ナビゲーターを終了し、全6ロールをフル稼働（それぞれ別のAIセッションで起動）
```

**重要:** Phase 7-8では6つのロールを**すべて別のAIセッション**で起動する。同一セッション内で複数ロールを担わせてはならない（相互牽制が機能しなくなる）。

### パターン2: コードレビューのみ

```
1つのAIセッション: core-principles + review-standards + code-reviewer
→ 品質ゲートとしてレビューを実施
```

### パターン3: セキュリティ監査のみ

```
1つのAIセッション: core-principles + review-standards + system-auditor
→ 安全ゲートとして監査を実施
```

### パターン4: レビュー＋監査の同時実施

```
セッションA: core-principles + review-standards + code-reviewer（品質ゲート）
セッションB: core-principles + review-standards + system-auditor（安全ゲート）
→ 2つのセッションを並行して実行し、両方の結果をオペレーターが確認
```

---

## HANDOFF_PROTOCOL（ロール間ハンドオフプロトコル）

6つのロールが独立セッションで稼働する場合、成果物の受け渡しを構造化する。
オペレーターの手動中継を最小化し、「意思決定に専念」（SP-1）を実現する。

### ハンドオフの原則

1. **成果物はファイルに書き出す:** 各ロールの出力は `outputs/` 配下または Git リポジトリ上のファイルとして永続化する
2. **参照はパスで伝える:** 次のロールには成果物の全文ではなくファイルパスとサマリーを提示する
3. **GitHub PR/Issue を中継媒体に使う:** `github-integration.md` のラベル体系と組み合わせ、ロール間の引き渡しを追跡可能にする

### ハンドオフフロー

```
[実装フロー]
コーディングエージェント
  → 実装完了報告（OUTPUT_FORMAT）+ PR 作成
  → コードレビュアーへ: PR URL + 実装完了報告のサマリー

コードレビュアー
  → 品質ゲートサマリー（review-output-template.md §1）を PR コメントに投稿
  → PASS: システム監査官へ PR URL + 「品質ゲート PASS」通知
  → FAIL: コーディングエージェントへ差し戻し（指摘事項一覧を含む）

システム監査官
  → 安全ゲートサマリー（review-output-template.md §2）を PR コメントに投稿
  → 完了: オペレーターへ PR URL + 品質ゲート・安全ゲート両方の結果サマリー

オペレーター
  → 最終判断（review-output-template.md §3）を記録
  → 承認: マージ。PM が progress-management.md §6 に記録
  → 差し戻し: 該当ロールへ修正指示
```

```
[フェーズ遷移フロー]
壁打ちナビゲーター（Phase 0-6）
  → ゲート判定レポート + セッションサマリーを outputs/phaseN/ に出力
  → Phase 7 移行時: PM・スクラムマスターへゲート判定結果を引き渡し

PM・スクラムマスター（Phase 7-8）
  → progress-management.md を継続更新
  → レビュー・監査結果を §6 に蓄積、技術的負債を §7 に登録
```

### ロール別アーティファクトマトリクス

| ロール | 主要出力 | 主要参照 | ハンドオフ先 |
|--------|---------|---------|-------------|
| 壁打ちナビゲーター | ゲート判定レポート、セッションサマリー、`outputs/phaseN/` 成果物 | `phase-definitions.md` ゲート条件 | Phase 7 移行時 → PM |
| コーディングエージェント | 実装コード、実装完了報告、PR | `outputs/phase5/` 設計ドキュメント、`outputs/phase3/` 要件定義 | → コードレビュアー |
| コードレビュアー | 品質ゲートサマリー（`review-output-template.md` §1） | 実装コード、実装完了報告 | PASS → システム監査官 / FAIL → コーディングエージェント |
| システム監査官 | 安全ゲートサマリー（`review-output-template.md` §2） | 実装コード（品質ゲート結果は参照しない。独立性維持） | → オペレーター |
| ユーザー・運用サポート | テストシナリオ、UX検証レポート、`outputs/phase6/feedback-log.md` | `outputs/phase2/usecases.md`、プロトタイプ/MVP実装 | → PM（フィードバック共有）、→ テクニカルライター（KB入力提供・品質検証） |
| テクニカルライター | `outputs/knowledge-base/` 配下のMDファイル、KB作成進捗レポート | `outputs/phase3/` 要件定義、`outputs/phase5/` 設計ドキュメント、テストシナリオ・UX検証結果 | → ユーザー・運用サポート（品質検証依頼）、→ オペレーター（網羅性検証結果） |
| PM・スクラムマスター | `progress-management.md`（§1-§8 全セクション） | レビュー・監査結果、ゲート判定レポート | → オペレーター（進捗報告） |
| 方法論エデュケーター | 評価レポート、アンチパターン記録、変更提案 | 全ロールの実践結果、pain-points | → オペレーター（改善承認） |

---

## SESSION_CONTINUITY（セッション継続戦略）

AIセッションのコンテキストウィンドウには上限がある。ロール切替やセッション終了時に、コンテキスト（決定事項、レビュー所見、実装状態）が失われることを防ぐ。

### セッション引継ぎプロトコル

新しいAIセッションを開始する際、以下の情報を渡してコンテキストをブートストラップする:

1. **現在フェーズと状態:** `progress-management.md` §1 のダッシュボードから現在フェーズ、ゲート条件達成率、ブロッカーを引用
2. **直近の意思決定:** `progress-management.md` §3 から直近3-5件の意思決定ログを引用
3. **アクティブなブロッカー/リスク:** `progress-management.md` §5 から未解消のブロッカー・リスクを引用
4. **直近のレビュー所見:** `progress-management.md` §6 から直近のレビュー・監査結果を引用（該当ロールの場合）
5. **技術的負債:** `progress-management.md` §7 から未解消の技術的負債サマリーを引用（該当ロールの場合）

### セッション再開プロンプトテンプレート

```
あなたはAIネイティブ開発チームの【ロール名】です。

【ロールのドキュメントセットを読み込み済み】

## 現在のプロジェクト状態
- 現在フェーズ: Phase X
- ゲート条件達成率: X / Y 条件達成
- ブロッカー: なし / あり（概要）

## 直近の意思決定（progress-management.md §3 より）
- YYYY-MM-DD: （決定内容と理由）
- YYYY-MM-DD: （決定内容と理由）

## 直近のレビュー・監査結果（該当する場合）
- （結果サマリー）

## 未解消の技術的負債（該当する場合）
- WARNING X件、最も多い分類: （分類名）

前回のセッションからの続きです。上記のコンテキストを前提に作業を再開してください。
```

### コンテキストウィンドウ枯渇時の対応

セッション中にコンテキストウィンドウが不足してきた場合:

1. **完了作業のサマリー化:** 完了した作業内容を要約し、`outputs/phaseX/session-log.md` に追記する
2. **アーカイブ:** 詳細なコードや議論の全文はセッションログに記録し、コンテキストから解放する
3. **新セッション開始:** 上記のセッション再開プロンプトテンプレートを使用して、サマリーで新セッションをブートストラップする

### ロール別のコンテキストブートストラップ要件

| ロール | 最低限必要な引継ぎ情報 |
|--------|---------------------|
| 壁打ちナビゲーター | 現在フェーズ、ゲート条件達成状況、直近の壁打ちサマリー |
| コーディングエージェント | 現在フェーズ、設計ドキュメントの場所、直近のレビュー指摘、未対応タスク |
| コードレビュアー | 現在フェーズ、技術スタック、データ機密度、前回レビューの指摘と対応状況 |
| システム監査官 | 現在フェーズ、技術スタック、データ機密度、動作環境、前回監査の指摘と対応状況 |
| ユーザー・運用サポート | 現在フェーズ、ユースケース一覧、前回テスト結果、未対応フィードバック |
| テクニカルライター | 現在フェーズ、機能要件一覧、KB作成進捗（カバー率）、サポート履歴フィードバック（未解決クエリ等） |
| PM・スクラムマスター | 現在フェーズ、ダッシュボード全体、直近の意思決定ログ、ブロッカー/リスク、技術的負債サマリー |
| 方法論エデュケーター | 評価対象プロジェクトの概要、pain-pointsインデックス、前回の評価結果 |

---

## CONTEXT_BUDGET（コンテキスト予算ガイダンス）

各ドキュメントの概算トークン数と、コンテキストウィンドウが制約される場合の優先度指針。

### ドキュメント別概算トークン数

| document_id | ファイル | 概算トークン数 | 優先度 |
|-------------|---------|--------------|--------|
| core-principles | common/core-principles.md | ~2,000 | コア（必須） |
| phase-definitions | common/phase-definitions.md | ~6,000 | コア（必須） |
| review-standards | common/review-standards.md | ~4,000 | コア（レビュー系ロール必須） |
| 各ロールプロンプト | roles/*.md | ~2,000-4,000 | コア（該当ロール必須） |
| progress-management | templates/progress-management.md | ~2,500 | リファレンス（PM必須、他ロールは任意） |
| review-output-template | templates/review-output-template.md | ~3,000 | リファレンス（レビュー系ロール） |
| phase-gate-checklists | templates/phase-gate-checklists.md | ~4,000 | リファレンス（ゲート判定時のみ） |

### コンテキスト制約時の戦略

**制約なし（128K+トークン）:** 全ドキュメントをフル読込可能。

**中程度の制約（32K-128Kトークン）:** コアドキュメント + ロールプロンプトをフル読込。テンプレートはリファレンスとして利用（必要な時だけ該当セクションを参照）。

**強い制約（32K未満）:** 以下の「コアのみ」サブセットを使用:
- `core-principles.md`: TOP_LEVEL_PRINCIPLE + STRUCTURAL_PRINCIPLES + CHECK_AND_BALANCE セクションのみ
- `phase-definitions.md`: 現在フェーズの定義 + PHASE_JUMP_RULES + TWO_LAYER_GATE_SYSTEM セクションのみ
- `review-standards.md`: REVIEW_ARCHITECTURE + 現在レビュー中の層のセクションのみ
- ロールプロンプト: 全文（各ロールの行動指針は圧縮不可）

---

## トラブルシューティング

### AIがロールの範囲を超えた行動をする場合

→ ロールプロンプトの `BOUNDARIES` セクションを再度参照するよう指示する。
例: 「あなたの BOUNDARIES セクションを確認してください。その作業はあなたの責務ではありません。」

### AIが@ref参照を解決できない場合

→ 参照先のドキュメントが読み込まれていない可能性がある。INDEX.mdのROLE_DOCUMENT_SETSを確認し、必要なドキュメントがすべてアップロード/読み込み済みか確認する。

### レビュー結果の粒度が粗い場合

→ review-standards.md のデシジョンツリーに沿って1つずつ確認するよう指示する。
例: 「review-standards.md の LAYER_1 から順に、デシジョンツリーに沿って判定してください。」
