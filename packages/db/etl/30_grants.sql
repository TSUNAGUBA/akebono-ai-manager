-- DB ユーザー分離(要件 7.5)。repeatable マイグレーション。
-- ロール自体の作成(パスワード設定を伴う)はマイグレーションに含めず、
-- scripts/setup/create-db-roles.sql を管理者が実行する(手順: docs/operations/deployment-setup.md)。
-- ここでは「ロールが存在すれば」権限を付与する(存在しない環境ではスキップ = 非ブロッキング)。

DO $$
BEGIN
  -- ai_manager_app_rw: chat-gateway / batch 用。ops / rag の読み書き
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_app_rw') THEN
    GRANT USAGE ON SCHEMA ops, rag TO ai_manager_app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO ai_manager_app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rag TO ai_manager_app_rw;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops, rag TO ai_manager_app_rw;
    -- パーティションは後から追加されるためデフォルト権限も設定
    ALTER DEFAULT PRIVILEGES IN SCHEMA ops GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_manager_app_rw;
    ALTER DEFAULT PRIVILEGES IN SCHEMA rag GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_manager_app_rw;
  END IF;

  -- ai_manager_dashboard_ro: ダッシュボード用。dwh の参照+ops の必要テーブルのみ参照
  -- (生の対話ログ ops.dialogues は含めない: 対話系は集計ビュー v_dialogue_daily_stats のみ)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_dashboard_ro') THEN
    GRANT USAGE ON SCHEMA dwh, ops TO ai_manager_dashboard_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA dwh TO ai_manager_dashboard_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA dwh GRANT SELECT ON TABLES TO ai_manager_dashboard_ro;
    GRANT SELECT ON ops.users, ops.customers, ops.projects, ops.tasks,
                    ops.task_status_log, ops.suggestions, ops.escalations, ops.reports,
                    ops.v_dialogue_daily_stats,
                    ops.industries, ops.customer_industries, ops.relation_types, ops.customer_relations
      TO ai_manager_dashboard_ro;
  END IF;

  -- ai_manager_admin_rw: ダッシュボードのマスタ管理ページ専用(v0.3 §5.1)。
  -- マスタ表と顧客のみ参照・書込可。既存の閲覧ロールの権限は広げない(最小権限)
  -- (ops.users は含めない: マスタ管理ページは users を参照せず、認証時のロール解決は
  --  閲覧ロール ai_manager_dashboard_ro 側のプールで行う)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_admin_rw') THEN
    GRANT USAGE ON SCHEMA ops TO ai_manager_admin_rw;
    GRANT SELECT ON ops.customers,
                    ops.industries, ops.customer_industries, ops.relation_types, ops.customer_relations
      TO ai_manager_admin_rw;
    GRANT INSERT, UPDATE ON ops.industries, ops.relation_types, ops.customers
      TO ai_manager_admin_rw;
    GRANT INSERT, UPDATE, DELETE ON ops.customer_industries, ops.customer_relations
      TO ai_manager_admin_rw;
    -- 過去の版で付与していた ops.users の SELECT を撤去する(適用済み環境を収束させる)
    REVOKE SELECT ON ops.users FROM ai_manager_admin_rw;
  END IF;
END
$$;
