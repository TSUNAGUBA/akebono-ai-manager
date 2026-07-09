---
document_id: index
type: document-index
version: 1.11.0
purpose: 全ドキュメントの索引・ロール別ドキュメントセット定義・クロスリファレンスマップ
---

# AI-Native Development Methodology — Document Index

本インデックスはAIエージェントがドキュメントセットをロードする際の参照先として機能する。

---

## DOCUMENT_REGISTRY

### 共通ドキュメント（common/）

| document_id | ファイル | 目的 | 参照元 | 概算トークン数 |
|-------------|---------|------|--------|--------------|
| core-principles | common/core-principles.md | 最上位原則・構造原則・ドキュメント図解ルール・実装品質原則・牽制関係 | 全ロール | ~2,500 |
| phase-definitions | common/phase-definitions.md | Phase 0-8の定義・ゲート条件・差し戻しルール・壁打ち指針 | 全ロール | ~6,000 |
| review-standards | common/review-standards.md | 4層レビュー構造・7つのレビュー視点（データ設計・I/F設計・コード品質）・デシジョンツリー・出力形式 | code-reviewer, system-auditor, coding-agent | ~4,000 |
| tool-feature-mapping | common/tool-feature-mapping.md | AIツール機能と方法論上の活用ポイントのマッピング | 全ロール | ~1,000 |

### ロールプロンプト（roles/）

| document_id | ファイル | ロール名 | 主要稼働フェーズ |
|-------------|---------|---------|-----------------|
| role-pm-scrum-master | roles/pm-scrum-master.md | PM・スクラムマスター | Phase 7-8 |
| role-coding-agent | roles/coding-agent.md | コーディングエージェント | Phase 5以降 |
| role-code-reviewer | roles/code-reviewer.md | コードレビュアー | Phase 5-8（Phase 5-6はインクリメンタルモード） |
| role-system-auditor | roles/system-auditor.md | システム監査官 | Phase 5-8（Phase 5-6はインクリメンタルモード） |
| role-user-ops-support | roles/user-ops-support.md | ユーザー・運用サポート | Phase 6以降 |
| role-technical-writer | roles/technical-writer.md | テクニカルライター | Phase 7-8 |
| role-navigator | roles/navigator.md | 壁打ちナビゲーター | Phase 0-6 |
| role-educator | roles/educator.md | 方法論エデュケーター | 全Phase（メタロール） |

### 運用テンプレート（templates/）

| document_id | ファイル | 目的 | 利用者 |
|-------------|---------|------|--------|
| role-startup-guide | templates/role-startup-guide.md | 各AIロールを実際のAIツールに読み込ませる手順・起動指示テンプレート | オペレーター・チームメンバー |
| review-output-template | templates/review-output-template.md | 品質ゲート・安全ゲート・オペレーター判断の出力テンプレート | code-reviewer, system-auditor, オペレーター |
| phase-gate-checklists | templates/phase-gate-checklists.md | 全フェーズのゲート条件チェックリスト（案件ごとにコピーして使用） | オペレーター |
| progress-management | templates/progress-management.md | プロジェクト進捗ダッシュボード・意思決定ログ・フェーズ遷移履歴（案件ごとにコピーして使用） | PM・スクラムマスター, オペレーター |

### ドメインコンテキスト（domain-context/）

| ディレクトリ | 目的 | 利用者 |
|-------------|------|--------|
| domain-context/industry/ | 業界の商慣習・規制・専門用語・トレンド | 壁打ちナビゲーター, オペレーター |
| domain-context/business-flow/ | ユーザーの業務フロー（時系列・入出力・非効率箇所） | 壁打ちナビゲーター, オペレーター |
| domain-context/persona/ | 利用者像・利用シーン・ペインポイント | 壁打ちナビゲーター, ユーザー・運用サポート, オペレーター |

ドメインコンテキストはプロジェクト横断で使い回せる参考資料。Phase 0開始前にAIセッションへ手動で読み込ませる。詳細は `domain-context/README.md` を参照。

---

## ROLE_DOCUMENT_SETS（ロール別ドキュメントセット）

各ロールをAIに担わせる際に読み込ませるドキュメントの組み合わせ。

### PM・スクラムマスター

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: フェーズ管理・ゲート条件
  3. roles/pm-scrum-master.md        ← 必須: ロール定義・行動指針
  4. templates/progress-management.md ← 必須: 進捗管理テンプレート・記録ルール
```

### コーディングエージェント

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: フェーズ定義（特にPhase 5の設計原則）
  3. common/review-standards.md      ← 必須: レビュー基準を理解した上で実装する
  4. roles/coding-agent.md           ← 必須: ロール定義・行動指針
```

### コードレビュアー

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/review-standards.md      ← 必須: 7つのレビュー視点・デシジョンツリー
  3. roles/code-reviewer.md          ← 必須: ロール定義・行動指針
```

### システム監査官

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/review-standards.md      ← 必須: レビュー基準（特に非機能層）
  3. roles/system-auditor.md         ← 必須: ロール定義・監査範囲
```

### ユーザー・運用サポート

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: フェーズ定義（特にPhase 2のユースケース、Phase 6のフィードバック）
  3. common/review-standards.md      ← 必須: ユーザビリティ基準（USABILITY_STANDARDS）
  4. roles/user-ops-support.md       ← 必須: ロール定義・行動指針
```

### テクニカルライター

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: フェーズ定義（特にPhase 7-8のゲート条件）
  3. roles/technical-writer.md       ← 必須: ロール定義・KB形式・サポート履歴形式
  4. roles/user-ops-support.md       ← 必須: ユーザー・運用サポートとの連携を理解する
```

### 壁打ちナビゲーター

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: 全フェーズのゲート条件・壁打ち指針・差し戻しルール
  3. roles/navigator.md              ← 必須: ロール定義・壁打ちの姿勢・ゲート判定方法・アドホック招集・並行タスクコーディネーション
  4. common/tool-feature-mapping.md  ← 任意: AIツール機能の活用ポイント参照
  5. domain-context/**/*.md          ← 任意: 該当するドメインコンテキストがあれば読み込み
```

### 方法論エデュケーター

```
load:
  1. common/core-principles.md      ← 必須: 最上位原則・構造原則
  2. common/phase-definitions.md     ← 必須: フェーズ定義・ゲート条件（有効性評価の基準）
  3. common/review-standards.md      ← 必須: レビュー基準（レビュー品質の評価基準）
  4. roles/educator.md               ← 必須: ロール定義・改善プロセス・評価観点
```

---

## CROSS_REFERENCE_MAP（クロスリファレンス）

ドキュメント間の参照関係:

```
core-principles ←─── 全ロールプロンプト（最上位原則・構造原則）
       │
       ├─── phase-definitions ←─── pm-scrum-master, coding-agent, user-ops-support, navigator
       │         │
       │         └─── phase-gate-checklists（ゲート条件をチェックリスト化）
       │
       ├─── review-standards ←─── code-reviewer, system-auditor, coding-agent, user-ops-support
       │         │
       │         └─── review-output-template（レビュー出力の統合テンプレート）
       │
       ├─── progress-management ←─── pm-scrum-master（進捗ダッシュボード・意思決定ログ・フェーズ遷移履歴）
       │
       ├─── technical-writer ←─── user-ops-support（テストシナリオ・UX検証結果を入力、品質検証でフィードバック）
       │         │
       │         └─── outputs/knowledge-base/（サポートボット用RAGナレッジベース）
       │
       ├─── role-startup-guide（全ロールの起動手順。INDEX.mdのROLE_DOCUMENT_SETSを実践に落とし込む）
       │
       ├─── educator（方法論エデュケーター: core-principles + phase-definitions + review-standards を横断的に評価・改善）
       │
       └─── tool-feature-mapping ←─── 全ロール（AIツール機能の活用ポイント。ナビゲーターが主に参照）
```

### 参照記法

ドキュメント内の `@ref:document-id#SECTION_ID` は以下のように解決する:
- `@ref:core-principles#TOP_LEVEL_PRINCIPLE` → core-principles.md の TOP_LEVEL_PRINCIPLE セクション
- `@ref:core-principles#SP-3` → core-principles.md の SP-3（2層ゲートシステム）
- `@ref:core-principles#SP-4` → core-principles.md の SP-4（レビューの2ゲート構造）
- `@ref:core-principles#SP-5` → core-principles.md の SP-5（壁打ちの姿勢）
- `@ref:core-principles#SP-6` → core-principles.md の SP-6（選択肢ベースのインタラクション）
- `@ref:core-principles#SP-7` → core-principles.md の SP-7（アドホックロールオーケストレーション）
- `@ref:core-principles#SP-8` → core-principles.md の SP-8（インクリメンタルレビューパイプライン）
- `@ref:core-principles#DOCUMENTATION_VISUALIZATION_RULES` → core-principles.md のドキュメント図解ルール
- `@ref:phase-definitions#Phase3` → phase-definitions.md の Phase 3 セクション
- `@ref:phase-definitions#PHASE_JUMP_RULES` → phase-definitions.md の差し戻しルール
- `@ref:review-standards#LAYER_3` → review-standards.md のコード層セクション
- `@ref:review-standards#REVIEW_EXECUTION_ORDER` → review-standards.md の実行順序セクション
- `@ref:review-standards#INCREMENTAL_REVIEW_SCOPE` → review-standards.md のインクリメンタルレビュースコープセクション
- `@ref:progress-management` → templates/progress-management.md の進捗管理テンプレート全体

---

## USAGE_PATTERNS（利用パターン）

### パターン1: 案件の全工程を回す

Phase 0から始めて全フェーズを通す場合。

```
Phase 0-6: navigator（壁打ちナビゲーター）を起動
           → フェーズナビゲーション・壁打ち・ゲート判定を担う
Phase 5:   + coding-agent を追加（プロトタイプ開発。navigatorと並行稼働）
Phase 6:   + user-ops-support を追加（フィードバック収集）
Phase 7-8: navigatorを終了し、全6ロール（PM, Coding, Reviewer, Auditor, UserSupport, TechnicalWriter）をフル稼働
```

### パターン2: コードレビューのみ

既存のコードに対してレビューを実施する場合。

```
load: core-principles + review-standards + code-reviewer
→ 品質ゲートとしてレビューを実施
```

### パターン3: セキュリティ監査のみ

既存のコードに対して安全性監査を実施する場合。

```
load: core-principles + review-standards + system-auditor
→ 安全ゲートとして監査を実施
```

### パターン4: 方法論の振り返り・改善

プロジェクト完了後、または定期的に方法論の有効性を評価・改善する場合。

```
load: core-principles + phase-definitions + review-standards + educator
→ プロジェクト実践から得られた知見を方法論にフィードバック
```

### パターン5: 既存システムへの中規模機能追加（Medium スコープ）

既存の設計・要件に増分する変更を行う場合。Phase 3 から開始し、圧縮フローで実施する。

```
Phase 3（圧縮版）: 既存要件への増分として要件を定義
Phase 5（圧縮版）: 既存設計への増分としてI/F設計をレビュー
Phase 7-8（統合）: 実装 → SP-8 インクリメンタルレビュー → 二重ゲートレビュー → オペレーター承認
  → インクリメンタルレビュー: 実装タスク完了ごとに CLEAR/ISSUE で品質・安全チェック
  → ゲートレビュー: 蓄積されたインクリメンタル記録を参照しつつ全体を判定

load: core-principles + phase-definitions + coding-agent + code-reviewer + system-auditor
```

### パターン6: バグ修正・小規模変更（Minimal スコープ）

既存の設計・アーキテクチャを変更しない小規模な修正。

```
1. coding-agent: 修正を実装
2. code-reviewer: 品質ゲート（変更差分に関連する視点のみ）
3. system-auditor: 安全ゲート（セキュリティ・安定性への影響がある場合のみフル監査）
4. オペレーター: 承認

load: core-principles + review-standards + coding-agent + code-reviewer + system-auditor
```

### パターン7: 緊急対応（EMERGENCY_PATH）

本番障害・セキュリティ脆弱性への緊急対応。

```
1. トリアージ（オペレーター）
2. 最小スコープ修正（coding-agent）
3. 二重ゲートレビュー（code-reviewer + system-auditor、並行実施可）
4. オペレーター承認 → デプロイ
5. ポストモーテム（48時間以内）

load: core-principles + review-standards + coding-agent + code-reviewer + system-auditor
詳細: phase-definitions.md EMERGENCY_PATH
```

### パターン8: アドホック協議（テーマ別議決）

特定テーマについてマルチロールの視点で検討・議決する場合。フェーズ進行とは独立。

```
1. オペレーターがナビゲーターにテーマを提示
2. ナビゲーターが必要なロールを招集（SP-7）
3. 各ロールの視点でテーマを検討
4. 結果を2層構成（サマリー＋詳細）で報告
5. オペレーターが判断

load: core-principles + navigator + テーマに応じたロール
```

### パターン9: 並行タスク実行

複数の独立タスクを並行処理する場合。

```
1. ナビゲーターがタスクの依存関係を分析
2. 並行実行可能なグループを特定
3. 各ロールにタスクを分配（同一ロール複数インスタンス可）
4. 結果を集約・報告

load: core-principles + navigator + タスクに応じたロール
```

---

## VERSIONING_PROTOCOL（バージョニングプロトコル）

### バージョン体系

セマンティックバージョニング（MAJOR.MINOR.PATCH）を採用する。

| 変更種別 | バージョン変更 | 例 |
|---------|--------------|---|
| 破壊的変更（ロール定義の廃止、フェーズ構造の変更、ゲート条件の根本的変更等） | MAJOR | 1.0.0 → 2.0.0 |
| 機能追加・改善（新セクション追加、プロトコル追加、既存定義の拡張等） | MINOR | 1.0.0 → 1.1.0 |
| 誤字修正・明確化（既存の意味を変えない修正） | PATCH | 1.0.0 → 1.0.1 |

### バージョン統一ルール

- 全ドキュメントのフロントマター `version` フィールドは同一バージョンに統一する
- バージョン変更時は全ドキュメントのフロントマターを一括更新する
- CHANGELOG セクションに変更概要を記録する

### 変更プロセス

1. 方法論エデュケーターまたはオペレーターが変更提案を作成する
2. オペレーターが承認する
3. 全ドキュメントのフロントマターバージョンを一括更新する
4. CHANGELOG に変更概要を追記する

---

## CHANGELOG

| バージョン | 日付 | 変更概要 |
|-----------|------|---------|
| 1.11.0 | 2026-04-01 | 運用可観測性・エラーコード管理ルール追加。system-auditor.md AS-3に運用監視の可視化手段・ユーザーアクションログ設計指針を追加。review-standards.md Layer 3エラーハンドリングにエラーコード管理要件を新設。coding-agent.md IMPLEMENTATION_STANDARDSにエラーコード管理セクション追加、D-3・OUTPUT_FORMATにエラーコード確認追加。technical-writer.md troubleshootingテンプレートにエラーコード欄追加、D-2にエラーコード逆引きリファレンス作成義務追加。code-reviewer.md RP-5にエラーコード検証追加。user-ops-support.md D-5にエラーコードサポート活用確認追加。phase-definitions.md Phase 7/8ゲート条件に運用監視可視化・エラーコード管理・エラーコード逆引きリファレンスを追加。phase-gate-checklists.md Phase 7/8チェックリスト更新。review-output-template.md インクリメンタル品質チェックにエラーコード確認追加。CLAUDE.md Push前チェック項目4拡張。全ドキュメントのフロントマターバージョンをv1.11.0に統一 |
| 1.10.0 | 2026-03-28 | コスト評価にユーザー体感劣化コストを明示的に含める規定を追加。review-standards.md・core-principles.md・navigator.mdを更新 |
| 1.9.0 | 2026-03-20 | インクリメンタルレビューパイプライン（SP-8）新設。実装タスク完了ごとにコードレビュアー（品質チェック）→システム監査官（安全チェック）を変更スコープに対して実施し、すべての指摘が解消するまでイテレーションを繰り返す。ゲートレビューとは独立した品質早期確保プロセス（判定値 CLEAR/ISSUE）。コードレビュアー・システム監査官の active_phases を [7,8] から [5,6,7,8] に拡張（Phase 5-6 はインクリメンタルモードのみ）。review-standards.md に INCREMENTAL_REVIEW_SCOPE セクション（スコープ定義・視点適用マトリクス・トリビアル変更判定）追加。review-output-template.md に §4 インクリメンタルレビューテンプレート（品質チェック・安全チェック・トリビアルスコープ確認）追加。coding-agent.md の D-3/D-4/OUTPUT_FORMAT にインクリメンタルレビュー参照追加。phase-definitions.md の Phase 5/7/8 にインクリメンタルレビューを正式統合。牽制関係マップにインクリメンタルレビューの牽制関係追加。全ドキュメントのフロントマターバージョンを v1.9.0 に統一 |
| 1.8.0 | 2026-03-16 | アドホックロールオーケストレーション機能追加（SP-7新設）。ナビゲーターにD-5（アドホックロール招集・マルチロール協議）とD-6（並行タスクコーディネーション）を追加。コーディングエージェントにD-5（並行実装の受容）を追加。方法論エデュケーターにD-5（アドホック協議ログの分析）を追加。思考過程の透明性を2層構成（サマリー層＋詳細層）で制度化。AIツール機能マッピング（tool-feature-mapping.md）を新設。利用パターン8（アドホック協議）・パターン9（並行タスク実行）を追加。牽制関係マップにアドホック招集の関係を追加。全ドキュメントのフロントマターバージョンをv1.8.0に統一 |
| 1.7.0 | 2026-03-12 | v4方法論評価レポートに基づく包括的改善。テスト戦略の構造的追加（N-13: coding-agent D-3/IMPLEMENTATION_STANDARDS/OUTPUT_FORMAT、review-standards LAYER_3 3.5テスト設計）。セキュリティ実装基準の追加（N-27: coding-agent IMPLEMENTATION_STANDARDS §セキュリティ）。D-3とOUTPUT_FORMAT自己チェックリストの一致（N-25）。レビュー指摘への異議申し立てフロー追加（N-26）。USABILITY_STANDARDS対応関係表修正・アクセシビリティ観点追加（N-16/N-28: U-5/UX-6新設）。ユーザー・運用サポートにD-6 KB品質検証責務追加（N-15）。システム監査官の安全ゲート拡充: サプライチェーンセキュリティ（N-21）、観測可能性（N-24）、クラウドネイティブ致命パターン（N-20）、監査深度マトリクス・緊急時監査スコープ（N-22/N-23）。PM INTERACTION_RULESにテクニカルライター追加（N-30）、Phase 7稼働開始プロトコル追加（N-31）。テクニカルライターのフロントマターID命名規則修正（N-33）、フィードバックレポート運用サイクル定義（N-34）。全ドキュメントのフロントマターバージョンをv1.7.0に統一（N-14: VERSIONING_PROTOCOL準拠） |
| 1.5.0 | 2026-03-10 | コードレビュアー7視点の再構成: データ設計(RP-1)・インターフェース設計(RP-2)を追加し、セキュリティ・リソースコストをシステム監査官に一本化。4層レビュー構造と7視点の整合性を確立。SP-5にPhase 6「整理・検証する姿勢」を追加。SP-4に直列制約の根拠を明文化。progress-management.md稼働ロール表にテクニカルライター追加 |
| 1.4.0 | 2026-03-10 | テクニカルライターロール追加: サポートボット用RAGナレッジベースの作成・維持を担う8番目のロール。Phase 7ゲート条件にKB初版作成を追加。Phase 8ゲート条件にKB網羅性検証・品質検証・サポートボットテストを追加。`outputs/knowledge-base/` ディレクトリ構成定義。サポート履歴形式（SUPPORT_LOG_FORMAT）とフィードバックサイクル定義 |
| 1.3.0 | 2026-03-10 | ドメインコンテキスト機能追加: `.ai-native/domain-context/` ディレクトリ新設（industry/business-flow/persona の3カテゴリ）。Phase 0ゲート条件にドメインコンテキスト読み込み確認を追加。ナビゲーターのD-1にPhase 0開始時のドメインコンテキスト確認を追加。role-startup-guideにドメインコンテキスト読み込みガイドを追加 |
| 1.2.0 | 2026-03-10 | SP-6（選択肢ベースのインタラクション）追加: 全ロール共通の応答フォーマット原則。ナビゲーターの壁打ち指針にフェーズ別適用ガイドを追加。壁打ち姿勢セクションにSP-6バックリファレンスを追加 |
| 1.1.0 | 2026-03-09 | EMERGENCY_PATH追加、SCOPE_CLASSIFICATION追加、SESSION_CONTINUITY追加、技術的負債レジストリ追加、DELEGATION_PROTOCOL追加、CONTEXT_BUDGET追加、ハルシネーション対策強化、SoT宣言追加（CLAUDE.md/methodology間の責務分離）、ロール間ハンドオフプロトコル追加、VERSIONING_PROTOCOL定義、全ドキュメントバージョン統一 |
| 1.0.0 | — | 初版リリース: 9フェーズ定義、7ロール定義（ナビゲーター、コーディングエージェント、コードレビュアー、システム監査官、ユーザー・運用サポート、PM・スクラムマスター、方法論エデュケーター）、レビュー基準（4層×7視点）、運用テンプレート |

