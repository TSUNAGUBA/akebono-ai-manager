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
    -- 集計の手動実行(v0.12 §5): dwh 表への直接権限は与えず、SECURITY DEFINER の
    -- ETL 関数の実行のみを許可する(20_daily_etl.sql で PUBLIC から REVOKE 済み)
    GRANT USAGE ON SCHEMA dwh TO ai_manager_app_rw;
    GRANT EXECUTE ON FUNCTION dwh.run_daily_etl(DATE) TO ai_manager_app_rw;
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
                    ops.industries, ops.customer_industries, ops.relation_types, ops.customer_relations,
                    ops.customer_aliases, ops.project_milestones
      TO ai_manager_dashboard_ro;
  END IF;

  -- ai_manager_admin_rw: ダッシュボードのマスタ管理ページ専用(v0.3 §5.1)。
  -- マスタ表と顧客の参照・書込に加え、v0.8 でユーザーの問いかけ可否列のみ列単位で許可する。
  -- 既存の閲覧ロールの権限は広げない(最小権限)
  -- (ops.users の表レベル SELECT は付与しない: 認証時のロール解決は
  --  閲覧ロール ai_manager_dashboard_ro 側のプールで行う)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_admin_rw') THEN
    GRANT USAGE ON SCHEMA ops TO ai_manager_admin_rw;
    GRANT SELECT ON ops.customers, ops.projects,
                    ops.industries, ops.customer_industries, ops.relation_types, ops.customer_relations,
                    ops.customer_aliases
      TO ai_manager_admin_rw;
    -- v0.9: プロジェクト管理ページ用に ops.projects の書込を追加(物理削除は付与しない)
    GRANT INSERT, UPDATE ON ops.industries, ops.relation_types, ops.customers, ops.projects
      TO ai_manager_admin_rw;
    GRANT INSERT, UPDATE, DELETE ON ops.customer_industries, ops.customer_relations
      TO ai_manager_admin_rw;
    -- customer_aliases は顧客編集フォームの洗い替え(DELETE + INSERT)用(v0.9)。
    -- 洗い替えに UPDATE は不要のため付与しない(最小権限)
    GRANT INSERT, DELETE ON ops.customer_aliases TO ai_manager_admin_rw;
    -- プロジェクト計画情報(v0.10): マイルストーンはプロジェクト編集ページで CRUD する
    GRANT SELECT, INSERT, UPDATE, DELETE ON ops.project_milestones TO ai_manager_admin_rw;
    -- タスク進捗管理(v0.10 §3): 一覧表示(SELECT)と status 列のみの更新を許可する。
    -- タスクの起票・題名・担当・期限の変更は付与しない(起票は M3 の Chat 承認フローが SoT)。
    -- 状態遷移の履歴は task_status_log へ INSERT(changed_via='admin')で記録する
    GRANT SELECT ON ops.tasks TO ai_manager_admin_rw;
    GRANT UPDATE (status, updated_at, completed_at) ON ops.tasks TO ai_manager_admin_rw;
    GRANT SELECT, INSERT ON ops.task_status_log TO ai_manager_admin_rw;
    -- ナレッジ管理ページ(v0.4)の同期状態表示用の読取のみ。書込は付与しない
    -- (ナレッジの SoT は Drive。rag への書込は knowledge-sync ジョブ = app_rw の責務)
    GRANT USAGE ON SCHEMA rag TO ai_manager_admin_rw;
    GRANT SELECT ON rag.knowledge_chunks TO ai_manager_admin_rw;
    -- 過去の版で付与していた ops.users の表レベル SELECT を撤去する(適用済み環境を収束させる)。
    -- 注意: 表レベルの REVOKE は列レベルの権限も併せて剥奪する(PostgreSQL の REVOKE 仕様)。
    -- そのため列単位の GRANT は必ずこの REVOKE の後に置くこと(順序を入れ替えると
    -- repeatable 実行のたびに列権限が消える。順序は migrations.test.ts で固定している)
    REVOKE SELECT ON ops.users FROM ai_manager_admin_rw;
    -- ユーザー設定ページ(v0.8 /admin/users)用の最小権限: 一覧表示に必要な列の参照と、
    -- 問いかけ可否列のみの更新を列単位で許可する(email 等の他列には触れない)
    GRANT SELECT (user_id, display_name, role, active, chat_space_id, checkin_enabled)
      ON ops.users TO ai_manager_admin_rw;
    GRANT UPDATE (checkin_enabled) ON ops.users TO ai_manager_admin_rw;
    -- 対話ログ確認ページ(v0.12 §6 /admin/dialogues)用の参照。
    -- 「閲覧ロール(ai_manager_dashboard_ro)は生の対話ログを読めない」境界(要件 7.5)は
    -- 維持し、管理者限定ページ専用の書込ロール側にのみ SELECT を付与する
    -- (ページはアプリ層でも管理者限定 — 二重制御)。書込は付与しない
    -- (フィードバックの記録・訂正送信は batch = app_rw の責務)
    GRANT SELECT ON ops.dialogues TO ai_manager_admin_rw;
    GRANT SELECT ON ops.dialogue_feedback TO ai_manager_admin_rw;
  END IF;
END
$$;
