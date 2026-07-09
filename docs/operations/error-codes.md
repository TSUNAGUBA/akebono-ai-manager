# エラーコード逆引きリファレンス

エラーコードの定義(SoT)は `packages/shared/src/errors.ts`。本書はその逆引きで、コード変更時は必ず両方を更新する。
すべてのエラーは Cloud Logging に構造化ログ(`errorCode` フィールド)として出力される。

## AIM-1xxx: 設定・起動

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-1001 | 必須の環境変数が未設定 | deploy.yml の env / secrets 設定を確認(deployment-setup.md Step 4-5) |
| AIM-1002 | 環境変数の値が不正 | ログの `details.name` に該当する変数の値を修正 |

## AIM-2xxx: データベース

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-2001 | DB 接続失敗 | RDS の SG / VPC コネクタ / NAT 経路、Secret Manager の接続情報を確認 |
| AIM-2002 | クエリ実行失敗 | ログの `details.query` とスタックトレースを確認。マイグレーション未適用の可能性 |
| AIM-2003 | マイグレーション適用失敗 | db-migrate ジョブのログで失敗した SQL を特定 |
| AIM-2004 | 適用済みマイグレーションの変更を検出 | 適用済みファイルは変更禁止。新しい連番のマイグレーションを追加する |

## AIM-3xxx: 認証・Chat ゲートウェイ

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-3001 | Authorization ヘッダーなし | Chat 以外からの呼び出し。不審な場合はアクセス元を確認 |
| AIM-3002 | トークン検証失敗 | `GCP_PROJECT_NUMBER`(audience)と Chat アプリ構成を確認 |
| AIM-3003 | 未登録ユーザー | `ops.users` にユーザーを登録(seed-users.sample.sql) |
| AIM-3004 | 権限不足 | 管理者限定リソースへの member アクセス。仕様どおりの拒否 |
| AIM-3101 | 未対応の Chat イベント | 新しいイベント種別。対応要否を検討 |
| AIM-3102 | Chat メッセージ送信失敗 | Chat API の有効化、ランタイム SA のアプリ認証設定を確認 |
| AIM-3103 | リクエストボディ不正 | 呼び出し元のペイロードを確認 |

## AIM-4xxx: LLM・Embedding

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-4001 | Vertex AI 呼び出し失敗 | Vertex AI API の有効化、ランタイム SA の `roles/aiplatform.user`、モデル名を確認。HTTP 404(`Publisher model ... was not found`)はモデルが呼び出し先ロケーションで未提供 — `VERTEX_LOCATION` / `MODEL_*` の組み合わせを見直す(deployment-setup.md トラブルシューティング参照) |
| AIM-4002 | LLM 応答が不正(空・JSON 解析不能) | 一時的な場合はリトライで解消。頻発時はプロンプト/スキーマを確認 |
| AIM-4003 | Embedding 失敗 | `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`(rag スキーマの vector(768) と一致)を確認 |

## AIM-5xxx: バッチジョブ・外部連携

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-5001 | 不明なジョブ名 | Scheduler の URI(/jobs/{name})を確認 |
| AIM-5002 | ジョブ実行失敗 | ログの cause を確認。個別ユーザー/ファイルの失敗は継続されるため、これは全体の失敗 |
| AIM-5003 | Drive 同期失敗 | ナレッジフォルダのランタイム SA への共有、`KNOWLEDGE_DRIVE_FOLDER_ID` を確認 |
| AIM-5004 | レポート生成失敗 | 対話ログの状態と LLM エラー(AIM-4xxx)を確認 |

## AIM-6xxx: ダッシュボード

| コード | 意味 | 主な対処 |
|---|---|---|
| AIM-6001 | ダッシュボードのクエリ失敗 | dwh スキーマの ETL 実行状況、ai_manager_dashboard_ro の GRANT を確認 |
