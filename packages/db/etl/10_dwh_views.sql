-- 主要KPIビュー(要件 7.3)。repeatable マイグレーション: 内容変更で再適用される。
-- BI 閲覧用ロール(bi_ro)にはこれらのビューのみ GRANT する(管理者限定ビューは admin_ro)。

-- 管理者限定: メンバー成長観察(仮説表明率、AI補助率、gap分布、next_change言語化率)
CREATE OR REPLACE VIEW dwh.v_member_growth AS
WITH dlg AS (
  SELECT
    fd.user_key,
    dd.year,
    dd.month,
    count(*) AS dialogues,
    count(*) FILTER (WHERE ddt.dialogue_type = 'morning_checkin') AS morning_dialogues,
    count(*) FILTER (WHERE fd.hypothesis_stated) AS hypotheses_stated,
    count(*) FILTER (WHERE fd.hypothesis_stated AND fd.hypothesis_ai_assisted) AS hypotheses_ai_assisted,
    count(*) FILTER (WHERE fd.review_completed) AS reviews_completed,
    round(avg(fd.user_response_chars), 1) AS avg_response_chars
  FROM dwh.fact_dialogue fd
  JOIN dwh.dim_date dd ON dd.date_key = fd.date_key
  JOIN dwh.dim_dialogue_type ddt ON ddt.dialogue_type_key = fd.dialogue_type_key
  GROUP BY fd.user_key, dd.year, dd.month
),
hyp AS (
  SELECT
    fho.user_key,
    dd.year,
    dd.month,
    count(*) AS outcomes,
    count(*) FILTER (WHERE fho.gap_category IN ('none', 'minor')) AS small_gap_outcomes,
    count(*) FILTER (WHERE fho.gap_category IN ('major', 'opposite')) AS large_gap_outcomes,
    count(*) FILTER (WHERE fho.next_change_stated) AS next_change_stated_count
  FROM dwh.fact_hypothesis_outcome fho
  JOIN dwh.dim_date dd ON dd.date_key = fho.date_key
  GROUP BY fho.user_key, dd.year, dd.month
)
SELECT
  du.user_id,
  du.display_name,
  dlg.year,
  dlg.month,
  dlg.dialogues,
  dlg.morning_dialogues,
  dlg.hypotheses_stated,
  round(dlg.hypotheses_stated::numeric / NULLIF(dlg.morning_dialogues, 0), 3) AS hypothesis_rate,
  round(dlg.hypotheses_ai_assisted::numeric / NULLIF(dlg.hypotheses_stated, 0), 3) AS ai_assisted_rate,
  dlg.reviews_completed,
  dlg.avg_response_chars,
  COALESCE(hyp.outcomes, 0) AS hypothesis_outcomes,
  round(hyp.small_gap_outcomes::numeric / NULLIF(hyp.outcomes, 0), 3) AS small_gap_rate,
  round(hyp.large_gap_outcomes::numeric / NULLIF(hyp.outcomes, 0), 3) AS large_gap_rate,
  round(hyp.next_change_stated_count::numeric / NULLIF(hyp.outcomes, 0), 3) AS next_change_rate
FROM dlg
LEFT JOIN hyp ON hyp.user_key = dlg.user_key AND hyp.year = dlg.year AND hyp.month = dlg.month
JOIN dwh.dim_user du ON du.user_key = dlg.user_key;

-- 管理者限定: AI提案の採否パターン(メンバー別・カテゴリ別)
CREATE OR REPLACE VIEW dwh.v_suggestion_pattern AS
SELECT
  du.user_id,
  du.display_name,
  fas.category,
  count(*) AS suggestions,
  count(*) FILTER (WHERE fas.decision = 'accepted') AS accepted,
  count(*) FILTER (WHERE fas.decision = 'rejected') AS rejected,
  count(*) FILTER (WHERE fas.decision = 'modified') AS modified,
  count(*) FILTER (WHERE fas.decision IS NULL OR fas.decision = 'ignored') AS ignored,
  round(avg(CASE WHEN fas.decision_reason_stated THEN 1 ELSE 0 END)::numeric, 3) AS reason_stated_rate,
  round(avg(fas.hours_to_decision)::numeric, 1) AS avg_hours_to_decision
FROM dwh.fact_ai_suggestion fas
JOIN dwh.dim_user du ON du.user_key = fas.user_key
GROUP BY du.user_id, du.display_name, fas.category;

-- 全員: プロジェクト別ヘルス(lead_time、blocked率)
CREATE OR REPLACE VIEW dwh.v_project_health AS
SELECT
  dp.project_id,
  dp.project_name,
  dp.customer_name,
  dp.industry,
  dp.status,
  count(*) AS activities,
  count(DISTINCT fta.task_id) AS tasks_touched,
  count(*) FILTER (WHERE fta.status_to = 'done') AS tasks_completed,
  round(avg(fta.lead_time_hours) FILTER (WHERE fta.status_to = 'done'), 1) AS avg_lead_time_hours,
  round(avg(CASE WHEN fta.was_blocked THEN 1 ELSE 0 END)::numeric, 3) AS blocked_rate
FROM dwh.fact_task_activity fta
JOIN dwh.dim_project dp ON dp.project_key = fta.project_key
GROUP BY dp.project_id, dp.project_name, dp.customer_name, dp.industry, dp.status;

-- 管理者限定: AI コスト(日次・ユーザー別・モデル別)
CREATE OR REPLACE VIEW dwh.v_ai_cost AS
SELECT
  dd.full_date,
  du.user_id,
  du.display_name,
  fd.model_used,
  count(*) AS dialogues,
  sum(fd.input_tokens) AS input_tokens,
  sum(fd.output_tokens) AS output_tokens,
  round(sum(fd.cost_usd), 4) AS cost_usd
FROM dwh.fact_dialogue fd
JOIN dwh.dim_date dd ON dd.date_key = fd.date_key
JOIN dwh.dim_user du ON du.user_key = fd.user_key
GROUP BY dd.full_date, du.user_id, du.display_name, fd.model_used;

-- 管理者限定: エスカレーション件数とナレッジ還流率(キーパーソンリスク解消のKPI)
CREATE OR REPLACE VIEW dwh.v_knowledge_loop AS
SELECT
  dd.year,
  dd.month,
  count(*) AS escalations,
  count(*) FILTER (WHERE fe.knowledge_reflected) AS knowledge_reflected_count,
  round(avg(CASE WHEN fe.knowledge_reflected THEN 1 ELSE 0 END)::numeric, 3) AS knowledge_reflected_rate,
  round(avg(fe.hours_to_resolve)::numeric, 1) AS avg_hours_to_resolve
FROM dwh.fact_escalation fe
JOIN dwh.dim_date dd ON dd.date_key = fe.date_key
GROUP BY dd.year, dd.month;
