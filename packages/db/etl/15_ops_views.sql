-- ops 層の集計ビュー(repeatable: 毎回適用・冪等)。
--
-- ダッシュボード(dashboard_ro)は生の対話ログ(ops.dialogues)を参照できない設計
-- (要件 7.5 / プライバシー方針)のため、当日の朝夕問答の実施状況は
-- 発話内容を含まない本集計ビュー経由でのみ公開する。
-- PostgreSQL のビューは既定で所有者(マイグレーション実行ユーザー)の権限で実行されるため、
-- dashboard_ro には本ビューのみを 30_grants.sql で GRANT する。

CREATE OR REPLACE VIEW ops.v_dialogue_daily_stats AS
SELECT
  user_id,
  (created_at AT TIME ZONE 'Asia/Tokyo')::date AS jst_date,
  bool_or(dialogue_type = 'morning_checkin' AND hypothesis IS NOT NULL) AS checkin_answered,
  bool_or(review IS NOT NULL) AS review_completed,
  count(*) AS dialogues
FROM ops.dialogues
GROUP BY user_id, (created_at AT TIME ZONE 'Asia/Tokyo')::date;
