---
document_id: github-integration
type: guide
version: 1.0.0
purpose: GitHub機能を活用した進捗管理・状態可視化の運用ガイド
---

# GitHub連携 進捗管理ガイド

AIネイティブ開発方法論の進捗管理をGitHubの機能で実現するためのガイド。
「誰が見ても今の状態と変遷がわかる」をGitHub上で達成する。

---

## §1 ラベル体系

### フェーズラベル（phase:X）

プロジェクトの全Issueにフェーズラベルを付与する。

| ラベル | 色 | 説明 |
|--------|-----|------|
| `phase:0` | `#0E8A16` | 現状把握と目標設定 |
| `phase:1` | `#0E8A16` | 真の課題の追求 |
| `phase:2` | `#0E8A16` | 業務と実運用の明確化 |
| `phase:3` | `#1D76DB` | 要件定義 |
| `phase:4` | `#1D76DB` | 技術スタック確定 |
| `phase:5` | `#5319E7` | 基本設計 + プロトタイプ開発 |
| `phase:6` | `#5319E7` | プロトタイプベースのフィードバック |
| `phase:7` | `#B60205` | MVP構築 |
| `phase:8` | `#B60205` | フルスケール実装 |

### 種別ラベル

| ラベル | 色 | 説明 |
|--------|-----|------|
| `feature` | `#0075CA` | 機能要件 |
| `bug` | `#D73A4A` | バグ |
| `phase-gate` | `#FEF2C0` | フェーズゲート判定 |
| `decision` | `#D4C5F9` | 意思決定記録 |
| `review` | `#FBCA04` | レビュー関連 |
| `audit` | `#E4E669` | 監査関連 |
| `feedback` | `#C2E0C6` | フィードバック |
| `blocker` | `#B60205` | ブロッカー |
| `hotfix` | `#D93F0B` | 緊急対応（EMERGENCY_PATH適用） |

### 優先度ラベル

| ラベル | 色 | 説明 |
|--------|-----|------|
| `priority:high` | `#B60205` | 高（MVP必須 / 業務停止レベル） |
| `priority:medium` | `#FBCA04` | 中（リリースまでに必要） |
| `priority:low` | `#0E8A16` | 低（あれば望ましい） |

### ロールラベル

| ラベル | 色 | 説明 |
|--------|-----|------|
| `role:coding-agent` | `#1D76DB` | コーディングエージェント担当 |
| `role:code-reviewer` | `#5319E7` | コードレビュアー担当 |
| `role:system-auditor` | `#0E8A16` | システム監査官担当 |
| `role:user-support` | `#C2E0C6` | ユーザー・運用サポート担当 |
| `role:pm` | `#FBCA04` | PM・スクラムマスター担当 |

### ゲート状態ラベル

| ラベル | 色 | 説明 |
|--------|-----|------|
| `gate:pass` | `#0E8A16` | ゲート通過 |
| `gate:not-yet` | `#D73A4A` | ゲート未達 |
| `gate:reject` | `#D93F0B` | 差し戻しリクエスト |
| `quality-gate` | `#5319E7` | 品質ゲート対象 |
| `safety-gate` | `#B60205` | 安全ゲート対象 |

---

## §2 GitHub Projects ボード設計

### 推奨ボード構成

GitHub Projectsを使い、以下のビューを作成する。

#### ビュー1: フェーズ進行ボード（Board view）

カラム構成:
```
| Backlog | Phase 0-2 | Phase 3-4 | Phase 5-6 | Phase 7 MVP | Phase 8 Full | Done |
```

- Issueをフェーズに応じたカラムに配置
- フェーズゲートのIssueは各フェーズカラムの先頭に固定
- 差し戻し時はIssueを対応するカラムに戻す

#### ビュー2: イテレーション進捗（Table view / Phase 7-8用）

カラム構成:
```
| タスク | 担当ロール | 優先度 | 状態 | イテレーション |
```

状態:
- 未着手
- 進行中
- レビュー中（品質ゲート待ち）
- 監査中（安全ゲート待ち）
- 差し戻し
- 完了

#### ビュー3: 意思決定タイムライン（Table view）

`decision` ラベルのIssueをフィルタし、時系列で表示。

---

## §3 Issueテンプレートの使い分け

> **自動ラベリング:** `.github/workflows/issue-labeler.yml` により、テンプレートから作成されたIssueにはフェーズ・優先度・ゲート判定のラベルが自動付与されます。

### テンプレート一覧

| テンプレート | 用途 | 使用タイミング |
|-------------|------|--------------|
| 機能要件 (Feature Request) | 新機能の追加・拡張 | Phase 3以降で要件をタスク化するとき |
| バグ報告 (Bug Report) | 不具合の報告 | テスト・運用で不具合を発見したとき |
| フェーズゲート判定 (Phase Gate) | ゲート判定の記録 | フェーズのゲート判定を行うとき |
| 意思決定記録 (Decision Record) | 重要な意思決定の記録 | 技術選定・設計方針・差し戻し判断など |

### フェーズゲートIssueの運用ルール

1. 各フェーズ開始時に「Phase X ゲート判定」Issueを作成する
2. ゲート条件の達成状況をIssueのコメントで更新する
3. ゲート判定時にPASS/NOT YETを記録し、Issueをクローズ（PASSの場合）または更新（NOT YETの場合）する
4. ゲート判定Issueには `phase-gate` + `phase:X` ラベルを付与する
5. PASS時に `gate:pass`、NOT YET時に `gate:not-yet` ラベルを付与する

### 意思決定Issueの運用ルール

1. 重要な意思決定が行われたら「意思決定記録」Issueを即座に作成する
2. 決定内容、判断理由、影響範囲を必ず記録する
3. 関連するIssue（機能要件、フェーズゲートなど）をリンクする
4. `decision` + `phase:X` + カテゴリに応じたラベルを付与する

---

## §4 PRテンプレートの運用

> **自動チェック:** `.github/workflows/pr-checks.yml` により、PR作成・更新時にIssue参照の有無とセルフチェック完了状況が自動で確認され、結果がコメントとして投稿されます。

### PRの作成ルール

1. PRは必ずテンプレートに従って記述する
2. 関連するIssue番号を記載し、リンクする
3. 対応するフェーズと要件との整合性を明記する
4. セルフチェックリストをすべて確認してからレビューに出す

### レビュー・監査フロー

```
コーディングエージェント → PR作成
  ↓
コードレビュアー → 品質ゲートレビュー（quality-gate ラベル付与）
  ↓ PASS
システム監査官 → 安全ゲート監査（safety-gate ラベル付与）
  ↓ PASS
オペレーター → 最終判断 → マージ
```

- レビュー結果はPRコメントに `review-output-template.md` の形式で記載する
- FAIL時はPRに `gate:not-yet` ラベルを付与し、修正後に再レビューを依頼する

---

## §5 ラベルの一括セットアップ

新しいプロジェクトリポジトリでラベルを一括セットアップする。

> **リポジトリ初期化時の自動作成:** プロジェクトにリポジトリを連携すると、30個のラベルが自動的に作成されます。通常、手動でのセットアップは不要です。
>
> **手動での再実行・更新:** ラベルの説明や色を更新したい場合は `.github/workflows/label-setup.yml` を GitHub Actions から手動実行できます（`--force` フラグにより冪等）。セットアップ手順は `guides/ci-cd-setup.md` を参照してください。

以下は GitHub CLI で手動実行する場合のスクリプトです。

```bash
#!/bin/bash
# GitHub CLIが必要: https://cli.github.com/

REPO="owner/repo-name"

# フェーズラベル
gh label create "phase:0" --color "0E8A16" --description "Phase 0: 現状把握と目標設定" --repo "$REPO"
gh label create "phase:1" --color "0E8A16" --description "Phase 1: 真の課題の追求" --repo "$REPO"
gh label create "phase:2" --color "0E8A16" --description "Phase 2: 業務と実運用の明確化" --repo "$REPO"
gh label create "phase:3" --color "1D76DB" --description "Phase 3: 要件定義" --repo "$REPO"
gh label create "phase:4" --color "1D76DB" --description "Phase 4: 技術スタック確定" --repo "$REPO"
gh label create "phase:5" --color "5319E7" --description "Phase 5: 基本設計 + プロトタイプ開発" --repo "$REPO"
gh label create "phase:6" --color "5319E7" --description "Phase 6: プロトタイプベースのフィードバック" --repo "$REPO"
gh label create "phase:7" --color "B60205" --description "Phase 7: MVP構築" --repo "$REPO"
gh label create "phase:8" --color "B60205" --description "Phase 8: フルスケール実装" --repo "$REPO"

# 種別ラベル
gh label create "feature" --color "0075CA" --description "機能要件" --repo "$REPO"
gh label create "bug" --color "D73A4A" --description "バグ" --repo "$REPO"
gh label create "phase-gate" --color "FEF2C0" --description "フェーズゲート判定" --repo "$REPO"
gh label create "decision" --color "D4C5F9" --description "意思決定記録" --repo "$REPO"
gh label create "review" --color "FBCA04" --description "レビュー関連" --repo "$REPO"
gh label create "audit" --color "E4E669" --description "監査関連" --repo "$REPO"
gh label create "feedback" --color "C2E0C6" --description "フィードバック" --repo "$REPO"
gh label create "blocker" --color "B60205" --description "ブロッカー" --repo "$REPO"

# 優先度ラベル
gh label create "priority:high" --color "B60205" --description "高優先度" --repo "$REPO"
gh label create "priority:medium" --color "FBCA04" --description "中優先度" --repo "$REPO"
gh label create "priority:low" --color "0E8A16" --description "低優先度" --repo "$REPO"

# ロールラベル
gh label create "role:coding-agent" --color "1D76DB" --description "コーディングエージェント担当" --repo "$REPO"
gh label create "role:code-reviewer" --color "5319E7" --description "コードレビュアー担当" --repo "$REPO"
gh label create "role:system-auditor" --color "0E8A16" --description "システム監査官担当" --repo "$REPO"
gh label create "role:user-support" --color "C2E0C6" --description "ユーザー・運用サポート担当" --repo "$REPO"
gh label create "role:pm" --color "FBCA04" --description "PM・スクラムマスター担当" --repo "$REPO"

# ゲート状態ラベル
gh label create "gate:pass" --color "0E8A16" --description "ゲート通過" --repo "$REPO"
gh label create "gate:not-yet" --color "D73A4A" --description "ゲート未達" --repo "$REPO"
gh label create "quality-gate" --color "5319E7" --description "品質ゲート対象" --repo "$REPO"
gh label create "safety-gate" --color "B60205" --description "安全ゲート対象" --repo "$REPO"

echo "ラベルのセットアップが完了しました"
```

---

## §6 進捗の可視化パターン

### パターン1: 第三者が現在の状態を把握する

1. GitHub ProjectsのフェーズボードでIssueの分布を確認 → 現在どのフェーズにいるか一目でわかる
2. `phase-gate` ラベルのIssueを時系列で確認 → どのゲートを通過したかわかる
3. 最新のフェーズゲートIssueを開く → 現在のゲート条件達成状況がわかる

### パターン2: 意思決定の変遷を追跡する

1. `decision` ラベルでIssueをフィルタ → 全意思決定が時系列で確認可能
2. 特定のフェーズの決定を見たい場合は `decision` + `phase:X` でフィルタ
3. 各意思決定Issueのリンクから関連Issue・PRを辿れる

### パターン3: レビュー・監査の履歴を確認する

1. `quality-gate` / `safety-gate` ラベルのPRを確認 → レビュー・監査の履歴
2. 各PRのコメントにレビュー・監査結果が `review-output-template.md` の形式で記録されている
3. PASS/FAILの推移がラベルで追跡可能
