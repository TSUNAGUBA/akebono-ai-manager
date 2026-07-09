-- DB ユーザー分離(要件 7.5)。repeatable マイグレーション。
-- ロール自体の作成(パスワード設定を伴う)はマイグレーションに含めず、
-- scripts/setup/create-db-roles.sql を管理者が実行する(手順: docs/operations/deployment-setup.md)。
-- ここでは「ロールが存在すれば」権限を付与する(存在しない環境ではスキップ = 非ブロッキング)。

DO $$
BEGIN
  -- app_rw: chat-gateway / batch 用。ops / rag の読み書き
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT USAGE ON SCHEMA ops, rag TO app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rag TO app_rw;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops, rag TO app_rw;
    -- パーティションは後から追加されるためデフォルト権限も設定
    ALTER DEFAULT PRIVILEGES IN SCHEMA ops GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
    ALTER DEFAULT PRIVILEGES IN SCHEMA rag GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
  END IF;

  -- dashboard_ro: ダッシュボード用。dwh の参照+ops の必要テーブルのみ参照
  -- (生の対話ログ ops.dialogues は含めない: 対話系は集計ビュー v_dialogue_daily_stats のみ)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_ro') THEN
    GRANT USAGE ON SCHEMA dwh, ops TO dashboard_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA dwh TO dashboard_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA dwh GRANT SELECT ON TABLES TO dashboard_ro;
    GRANT SELECT ON ops.users, ops.customers, ops.projects, ops.tasks,
                    ops.task_status_log, ops.suggestions, ops.escalations, ops.reports,
                    ops.v_dialogue_daily_stats
      TO dashboard_ro;
  END IF;
END
$$;
