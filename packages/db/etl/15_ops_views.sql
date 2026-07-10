-- ops 層の集計ビュー(repeatable: 毎回適用・冪等)。
--
-- ダッシュボード(ai_manager_dashboard_ro)は生の対話ログ(ops.dialogues)を参照できない設計
-- (要件 7.5 / プライバシー方針)のため、当日の朝夕問答の実施状況は
-- 発話内容を含まない本集計ビュー経由でのみ公開する。
-- PostgreSQL のビューは既定で所有者(マイグレーション実行ユーザー)の権限で実行されるため、
-- ai_manager_dashboard_ro には本ビューのみを 30_grants.sql で GRANT する。

-- 注意: CREATE OR REPLACE VIEW は既存列の名前・型・順序の変更を許さないため、
-- 列の追加は必ず末尾に行うこと。
-- adhoc_checkin_answered の「返信あり」は turns 配列に role='user' 要素が
-- 存在するかで判定する(jsonb 包含演算子。発話内容は公開しない)。
CREATE OR REPLACE VIEW ops.v_dialogue_daily_stats AS
SELECT
  user_id,
  (created_at AT TIME ZONE 'Asia/Tokyo')::date AS jst_date,
  bool_or(dialogue_type = 'morning_checkin' AND hypothesis IS NOT NULL) AS checkin_answered,
  bool_or(review IS NOT NULL) AS review_completed,
  count(*) AS dialogues,
  bool_or(dialogue_type = 'morning_checkin') AS morning_checkin_sent,
  bool_or(dialogue_type = 'adhoc_checkin') AS adhoc_checkin_sent,
  bool_or(dialogue_type = 'adhoc_checkin' AND turns @> '[{"role":"user"}]'::jsonb)
    AS adhoc_checkin_answered
FROM ops.dialogues
GROUP BY user_id, (created_at AT TIME ZONE 'Asia/Tokyo')::date;
