-- DB ロール権限の検証(要件 7.5 / v0.3 §5.1 の最小権限を has_table_privilege で一覧確認する)
-- 実行者: 管理権限を持つユーザー(読み取りのみで何も変更しない。何度実行しても安全)
-- 実行方法:
--   psql "host=<RDS_HOST> dbname=ai_manager user=<ADMIN_USER> sslmode=require" -f verify-grants.sql
--
-- 前提: create-db-roles.sql でロール作成済み+db-migrate ジョブ(packages/db/etl/30_grants.sql)適用済み。
-- 期待値と異なる場合は db-migrate ジョブを再実行して GRANT を反映すること。

-- ── 1. ai_manager_dashboard_ro: マスタ4表は SELECT のみ可(書込は全て不可)──
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
        ('ops.customer_relations')
     ) AS t(tbl)
ORDER BY t.tbl;

-- ── 2. ai_manager_admin_rw: マスタ4表+customers のみ書込可 ──
-- 期待値:
--   table_name              | can_select | can_insert | can_update | can_delete
--   ops.industries          | t          | t          | t          | f
--   ops.relation_types      | t          | t          | t          | f
--   ops.customers           | t          | t          | t          | f
--   ops.customer_industries | t          | t          | t          | t
--   ops.customer_relations  | t          | t          | t          | t
-- (エンティティ本体は削除不可・関連付けの2表のみ削除可、が設計どおりの状態)
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
        ('ops.customers')
     ) AS t(tbl)
ORDER BY t.tbl;

-- ── 3. ai_manager_admin_rw: マスタ管理の対象外テーブルへは一切アクセス不可 ──
-- 期待値: 全行で can_select = f / can_insert = f / can_update = f / can_delete = f
-- (ops.users はマスタ管理ページが参照しないため SELECT も付与しない。
--  認証時のロール解決は ai_manager_dashboard_ro 側のプールで行う)
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
        ('ops.escalations'),
        ('rag.knowledge_chunks')
     ) AS t(tbl)
ORDER BY t.tbl;
