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
        ('ops.projects')
     ) AS t(tbl)
ORDER BY t.tbl;

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
--  列単位のみで、セクション5で別途検証する。認証時のロール解決は
--  ai_manager_dashboard_ro 側のプールで行う)
SELECT 'ai_manager_admin_rw' AS role_name,
       t.tbl AS table_name,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'SELECT') AS can_select,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'INSERT') AS can_insert,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'UPDATE') AS can_update,
       has_table_privilege('ai_manager_admin_rw', t.tbl, 'DELETE') AS can_delete
FROM (VALUES
        ('ops.users'),
        ('ops.tasks'),
        ('ops.dialogues'),
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
