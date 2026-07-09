# Phase 7 開発ログ(MVP 構築)

- 日付: 2026-07-09
- スコープ判定: Medium 相当(要件・基本設計は docs/refference が既存成果物。Phase 3-5 は圧縮し、Phase 7 実装に注力)
- 担当: ナビゲーター(コーディネート)+コーディングエージェント(実装)+コードレビュアー/システム監査官(ゲート)

## 実装内容

| # | タスク | 成果物 |
|---|---|---|
| 1 | モノレポ基盤+shared | npm workspaces / TypeScript strict / vitest。config・errors(エラーコード一元管理)・logger・db・http・vertex(モデルルーティング)・chat-api・prompts(SoT)・routing |
| 2 | db パッケージ | 要件 §7 の DDL(ops/rag/dwh)を versioned マイグレーション化。dwh ビュー+日次 ETL 関数を repeatable 化。pg_cron 登録(非対応環境ではスキップ)。冪等ランナー |
| 3 | chat-gateway | Chat JWT 検証、朝夕対話の状態機械(構造化出力で仮説/振り返り抽出)、RAG QA、確信度低下時のエスカレーション、日報確認・提案採否カード |
| 4 | batch | 朝の問いかけ(冪等・LLM不調時は定型文)、日報生成(確認済み日報は再生成しない状態保護)、週次サマリ、Drive ナレッジ同期(content_hash 差分) |
| 5 | dashboard | 単一デザインシステム(レスポンシブ、モバイルはカード型)、IAP 認証、管理者限定/個人ページ分離 |
| 6 | CI/CD | ci.yml(PR 検証)、deploy.yml(WIF → build → migrate → 3サービス → Scheduler、全て repository secrets 読取)、PowerShell セットアップスクリプト3本 |
| 7 | ドキュメント | deployment-setup.md、error-codes.md、phase1-implementation.md(ADR 5件)、README 全面更新 |

## 検証記録

- `npm run build`(tsc -b strict)/ `npm test`: 56 テスト全通過
- ダッシュボード: モック DB で全6ページをレンダリングし、Chromium で目視検証。
  モバイル(390px)エミュレーションで水平オーバーフローなし・カード型レイアウト適用を確認
- Docker ビルド: CI で検証(ci.yml に組込み)

## 設計判断

ADR-1〜5 を docs/architecture/phase1-implementation.md に記録
(自前マイグレーションランナー / 自前ダッシュボード / Agent Engine 見送り / WIF キーレス認証 / tenant_id 見送り)。

## 既知の制約(Phase 2 への引き継ぎ)

- M3(タスクオーケストレーション)未実装のため、タスクは当面 SQL または今後の管理 UI で登録する
- 祝日判定は未対応(Scheduler は平日 cron のみ)
- Chat からのナレッジ投入(「これナレッジに入れて」)は Phase 2
- Model Garden 経由 Claude ルーティングは未接続(要件どおり Phase 1 は Gemini のみで比較検証)

## 本番デプロイ後の障害対応(2026-07-09)

| 事象 | 原因 | 対処 |
|---|---|---|
| `/healthz` が Google の 404 を返す | Cloud Run フロントエンドの予約パス(コンテナ未到達) | ヘルスチェックパスを `/health` に変更(PR #3) |
| Chat からの呼び出しが 401 | Workspace アドオン基盤経由の新方式トークン(呼び出し元 `gcp-sa-gsuiteaddons`)未対応 | 新旧両方式のトークン検証に対応(PR #3) |
| Chat に応答が表示されない | 新方式は `hostAppDataAction` ラップ形式の応答が必須 | イベント正規化+応答ラップを実装(PR #4) |
| AIM-4001: Vertex AI HTTP 404(`gemini-2.5-flash-lite` not found) | モデルごとに提供ロケーションが異なり、gemini-2.5-flash-lite はグローバルエンドポイント限定。asia-northeast1 リージョナルに投げていた | 生成系は既定 global エンドポイント、embedding は既定リージョナルに分離(ADR-8)。`VERTEX_LOCATION` / `VERTEX_EMBEDDING_LOCATION` / `MODEL_*` を secrets 経由で運用変更可能に配線 |

Gemini 2.5 系は 2026-10-16 廃止予定。後継移行は `MODEL_*` secrets の変更+再デプロイのみで完了する(コード変更不要)。
