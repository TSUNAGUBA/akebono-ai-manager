-- DB ロール権限の検証(要件 7.5 / v0.3 §5.1 の最小権限を has_table_privilege で一覧確認する)
-- 実行者: 管理権限を持つユーザー(読み取りのみで何も変更しない。何度実行しても安全)
-- 実行方法:
--   psql "host=<RDS_HOST> dbname=ai_manager user=<ADMIN_USER> sslmode=require" -f verify-grants.sql
--
-- 前提: create-db-roles.sql でロール作成済み+db-migrate ジョブ(packages/db/etl/30_grants.sql)適用済み。
-- 期待値と異なる場合は db-migrate ジョブを再実行して GRANT を反映すること。

-- ── 1. ai_manager_dashboard_ro: マスタ表(エイリアス含む)は SELECT のみ可(書込は全て不可)──
-- 期待値: 全行で can_select = t / can_insert = f / can_update = f / can_delete = f
SELECT 'ai_manager_dashboard_ro' AS role_name,
       t.tbl AS table_name,
       has_table_privilege('ai_manager_dashboard_ro', t.tbl, 'SELECT') AS can_select,
       has_table_privilege('ai_manager_dashboard_ro', t.tbl, 'INSERT') AS can_insert,
       has_table_privilege('ai_manager_dashboard_ro', t.tbl, 'UPDATE') AS can_update,
       has_table_privilege('ai_manager_dashboard_ro', t.tbl, 'DELETE') AS can_delete
FROM (VALUES
        ('ops.industries'),
        ('ops.customer_industries'),
        ('ops.relation_types'),
        ('ops.customer_relations'),
        ('ops.customer_aliases')
     ) AS t(tbl)
ORDER BY t.tbl;

-- ── 2. ai_manager_admin_rw: マスタ表+customers+projects(v0.9)の書込可 ──
-- 期待値:
--   table_name              | can_select | can_insert | can_update | can_delete
--   ops.industries          | t          | t          | t          | f
--   ops.relation_types      | t          | t          | t          | f
--   ops.customers           | t          | t          | t          | f
--   ops.projects            | t          | t          | t          | f
--   ops.customer_industries | t          | t          | t          | t
--   ops.customer_relations  | t          | t          | t          | t
--   ops.customer_aliases    | t          | t          | f          | t
-- (エンティティ本体は削除不可・関連付け/エイリアスのみ削除可(洗い替え用)。
--  customer_aliases の UPDATE は洗い替えに不要のため不可、が設計どおりの状態)
SELECT 'ai_manager_admin_rw' AS role_name,
       t.tbl AS table_name,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'SELECT') AS can_select,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'INSERT') AS can_insert,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'UPDATE') AS can_update,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'DELETE') AS can_delete
FROM (VALUES
        ('ops.industries'),
        ('ops.customer_industries'),
        ('ops.relation_types'),
        ('ops.customer_relations'),
        ('ops.customer_aliases'),
        ('ops.customers'),
        ('ops.projects'),
        ('ops.project_milestones')
     ) AS t(tbl)
ORDER BY t.tbl;
-- 補足(v0.10): ops.project_milestones はプロジェクト編集ページの CRUD 用に
-- t / t / t / t(計画データのため削除可)が期待値。

-- ── 3. ai_manager_admin_rw: ナレッジ管理(v0.4)の同期状態表示は読取のみ可 ──
-- 期待値: can_select = t / can_insert = f / can_update = f / can_delete = f
-- (ナレッジの SoT は Drive。rag への書込は knowledge-sync ジョブ = ai_manager_app_rw の責務)
SELECT 'ai_manager_admin_rw' AS role_name,
       'rag.knowledge_chunks' AS table_name,
       has_table_privilege('ai_manager_admin_rw', 'rag.knowledge_chunks', 'SELECT') AS can_select,
       has_table_privilege('ai_manager_admin_rw', 'rag.knowledge_chunks', 'INSERT') AS can_insert,
       has_table_privilege('ai_manager_admin_rw', 'rag.knowledge_chunks', 'UPDATE') AS can_update,
       has_table_privilege('ai_manager_admin_rw', 'rag.knowledge_chunks', 'DELETE') AS can_delete;

-- ── 4. ai_manager_admin_rw: マスタ管理の対象外テーブルへは表レベルのアクセス不可 ──
-- 期待値: 全行で can_select = f / can_insert = f / can_update = f / can_delete = f
-- (ops.users は表レベルの権限を付与しない。ユーザー設定ページ v0.8 用の権限は
--  列単位のみで、セクション5で別途検証する。ops.tasks は v0.10 で SELECT+status 列の
--  UPDATE のみ付与されたため、セクション6で別途検証する。ops.dialogues は v0.12 で
--  SELECT のみ付与されたため、セクション7で別途検証する。認証時のロール解決は
--  ai_manager_dashboard_ro 側のプールで行う)
SELECT 'ai_manager_admin_rw' AS role_name,
       t.tbl AS table_name,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'SELECT') AS can_select,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'INSERT') AS can_insert,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'UPDATE') AS can_update,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'DELETE') AS can_delete
FROM (VALUES
        ('ops.users'),
        ('ops.escalations')
     ) AS t(tbl)
ORDER BY t.tbl;

-- ── 5. ai_manager_admin_rw: ops.users は列単位の最小権限(v0.8 §4)──
-- 期待値: 表示列の SELECT = t / email の SELECT = f /
--         checkin_enabled の UPDATE = t / 他列(例: display_name)の UPDATE = f
SELECT 'ai_manager_admin_rw' AS role_name,
       'ops.users(列単位)' AS target,
       has_column_privilege('ai_manager_admin_rw', 'ops.users', 'user_id', 'SELECT') AS can_select_user_id,
       has_column_privilege('ai_manager_admin_rw', 'ops.users', 'display_name', 'SELECT') AS can_select_display_name,
       has_column_privilege('ai_manager_admin_rw', 'ops.users', 'email', 'SELECT') AS can_select_email,
       has_column_privilege('ai_manager_admin_rw', 'ops.users', 'checkin_enabled', 'UPDATE') AS can_update_checkin,
       has_column_privilege('ai_manager_admin_rw', 'ops.users', 'display_name', 'UPDATE') AS can_update_display_name;

-- ── 6. ai_manager_admin_rw: タスク進捗管理(v0.10 §3)は SELECT+status 列の更新のみ ──
-- 期待値: tasks の SELECT = t / INSERT = f / DELETE = f /
--         status・updated_at・completed_at の UPDATE = t / title 等の他列の UPDATE = f /
--         task_status_log の SELECT・INSERT = t / UPDATE・DELETE = f
-- (タスクの起票・題名・担当・期限の変更は M3 の Chat 承認フローが SoT のため付与しない)
SELECT 'ai_manager_admin_rw' AS role_name,
       'ops.tasks / ops.task_status_log' AS target,
       has_table_privilege('ai_manager_admin_rw', 'ops.tasks', 'SELECT') AS tasks_select,
       has_table_privilege('ai_manager_admin_rw', 'ops.tasks', 'INSERT') AS tasks_insert,
       has_table_privilege('ai_manager_admin_rw', 'ops.tasks', 'DELETE') AS tasks_delete,
       has_column_privilege('ai_manager_admin_rw', 'ops.tasks', 'status', 'UPDATE') AS tasks_update_status,
       has_column_privilege('ai_manager_admin_rw', 'ops.tasks', 'title', 'UPDATE') AS tasks_update_title,
       has_table_privilege('ai_manager_admin_rw', 'ops.task_status_log', 'INSERT') AS log_insert,
       has_table_privilege('ai_manager_admin_rw', 'ops.task_status_log', 'UPDATE') AS log_update,
       has_table_privilege('ai_manager_admin_rw', 'ops.task_status_log', 'DELETE') AS log_delete;

-- ── 7. 対話ログ確認ページ(v0.12 §7)の権限境界 ──
-- 期待値:
--   admin_rw:      dialogues / dialogue_feedback とも SELECT = t、書込は全て f
--                  (フィードバックの記録・訂正送信は batch = ai_manager_app_rw の責務)
--   dashboard_ro:  dialogues / dialogue_feedback とも SELECT = f
--                  (「閲覧ロールは生の対話ログを読めない」要件 7.5 の境界を維持)
SELECT r.role_name,
       t.tbl AS table_name,
       has_table_privilege(r.role_name, t.tbl, 'SELECT') AS can_select,
       has_table_privilege(r.role_name, t.tbl, 'INSERT') AS can_insert,
       has_table_privilege(r.role_name, t.tbl, 'UPDATE') AS can_update,
       has_table_privilege(r.role_name, t.tbl, 'DELETE') AS can_delete
FROM (VALUES ('ai_manager_admin_rw'), ('ai_manager_dashboard_ro')) AS r(role_name)
CROSS JOIN (VALUES ('ops.dialogues'), ('ops.dialogue_feedback')) AS t(tbl)
ORDER BY r.role_name, t.tbl;

-- ── 8. 集計 ETL の手動実行(v0.12 §6)は app_rw のみ実行可 ──
-- 期待値: app_rw = t / dashboard_ro = f / admin_rw = f
-- (SECURITY DEFINER 関数のため PUBLIC からは REVOKE 済み — 20_daily_etl.sql)
SELECT r.role_name,
       'dwh.run_daily_etl(date)' AS target,
       has_function_privilege(r.role_name, 'dwh.run_daily_etl(date)', 'EXECUTE') AS can_execute
FROM (VALUES ('ai_manager_app_rw'), ('ai_manager_dashboard_ro'), ('ai_manager_admin_rw')) AS r(role_name)
ORDER BY r.role_name;
