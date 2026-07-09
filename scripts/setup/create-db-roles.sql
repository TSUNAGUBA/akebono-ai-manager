-- DB ロール作成テンプレート(要件 7.5 DBユーザー分離)
-- 実行者: RDS のマスターユーザー等の管理権限を持つユーザー
-- 実行方法(psql 変数でパスワードを渡す):
--   psql "host=<RDS_HOST> dbname=ai_manager user=<ADMIN_USER> sslmode=require" \
--     -v app_rw_password='<強いパスワード>' \
--     -v dashboard_ro_password='<強いパスワード>' \
--     -f create-db-roles.sql
--
-- 権限の付与(GRANT)自体はマイグレーション(packages/db/etl/30_grants.sql)が
-- 冪等に行うため、本スクリプトはロール作成のみを担う。
-- ロール作成後にマイグレーション(db-migrate ジョブ)を再実行すると GRANT が適用される。

-- アプリケーション用(chat-gateway / batch): ops / rag の読み書き
SELECT format('CREATE ROLE ai_manager_app_rw LOGIN PASSWORD %L', :'app_rw_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_app_rw')
\gexec

-- ダッシュボード用: dwh 参照+ops の必要テーブルのみ参照(生の対話ログは参照不可)
SELECT format('CREATE ROLE ai_manager_dashboard_ro LOGIN PASSWORD %L', :'dashboard_ro_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_manager_dashboard_ro')
\gexec

-- 接続権限
GRANT CONNECT ON DATABASE ai_manager TO ai_manager_app_rw, ai_manager_dashboard_ro;
