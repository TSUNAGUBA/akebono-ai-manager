-- pg_cron ジョブ登録(要件 6.4 / 7.3)。repeatable: マイグレーション実行のたびに適用(冪等)。
-- 前提: RDS のパラメータグループで shared_preload_libraries に pg_cron が含まれ、
--       cron.database_name が本 DB(ai_manager)に設定されていること。
-- 拡張を作成できない環境ではスキップして通知のみ出す(非ブロッキング)。
-- pg_cron を後から有効化した場合は、db-migrate ジョブの再実行で自動登録される。
-- 共有 RDS インスタンスで pg_cron が既に別 DB に割り当てられている場合はここでは登録できないため、
-- その DB 側から cron.schedule_in_database で登録する(docs/operations/deployment-setup.md の手動フォールバック)。

DO $do$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron 拡張を作成できませんでした(%)。ETL ジョブは未登録です。docs/operations/deployment-setup.md の手動フォールバックを参照してください。', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- cron.schedule は同名ジョブを上書きするため冪等
    -- 02:30 JST = 17:30 UTC(pg_cron は UTC 基準)
    PERFORM cron.schedule('ai-manager-daily-etl', '30 17 * * *', 'SELECT dwh.run_daily_etl()');
    -- UTC 毎月1日 16:00 = JST 毎月2日 01:00 にパーティションを先行作成
    -- (ETL 側でも毎日防御的に確保するため、発火日のずれは実害なし)
    PERFORM cron.schedule('ai-manager-ensure-partitions', '0 16 1 * *',
      'SELECT ops.ensure_dialogue_partitions(3); SELECT dwh.ensure_fact_partitions(3);');
    RAISE NOTICE 'pg_cron ジョブを登録しました(ai-manager-daily-etl, ai-manager-ensure-partitions)';
  END IF;
END
$do$;
