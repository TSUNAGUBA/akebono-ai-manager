-- pg_cron ジョブ登録(要件 6.4 / 7.3)
-- 前提: RDS のパラメータグループで shared_preload_libraries に pg_cron が含まれ、
--       cron.database_name が本 DB(ai_manager)に設定されていること。
-- 拡張を作成できない環境ではスキップし、手動フォールバック手順
-- (docs/operations/deployment-setup.md)に委ねる(非ブロッキング)。

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
    -- 毎月1日 01:00 JST にパーティションを先行作成
    PERFORM cron.schedule('ai-manager-ensure-partitions', '0 16 1 * *',
      'SELECT ops.ensure_dialogue_partitions(3); SELECT dwh.ensure_fact_partitions(3);');
    RAISE NOTICE 'pg_cron ジョブを登録しました(ai-manager-daily-etl, ai-manager-ensure-partitions)';
  END IF;
END
$do$;
