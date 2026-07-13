-- ops → dwh 日次 ETL(要件 7.3)。pg_cron から毎日深夜(02:30 JST)に実行する。
-- repeatable マイグレーション: 毎回適用(冪等)。
--
-- 冪等性の設計(CLAUDE.md 原則2):
--   - 対象日のファクトは DELETE → INSERT で洗い替え(他の日付には触れない)
--   - fact_ai_suggestion / fact_escalation は後日の決定・解決を反映するため直近7日を洗い替え
--   - fact_hypothesis_outcome も翌日以降の振り返り完了を反映するため直近7日を洗い替え
--   - fact_workload はスナップショットを UPSERT
--   - ディメンションは SCD Type 2(変更検知→現行行クローズ+新行追加)

-- SECURITY DEFINER(v0.12): ダッシュボードの「集計を今すぐ実行」→ batch(ai_manager_app_rw)
-- からも実行できるようにする。app_rw へ dwh 表の直接書込権限は与えず、この関数の実行のみを
-- 許可する(最小権限)。定義者(マイグレーション実行ユーザー)はパーティション作成を含む
-- 全操作の権限を持ち、pg_cron からの定時実行は従来どおり動作する。
-- 本文の参照はすべてスキーマ修飾済みのため search_path は最小に固定する(乗っ取り防止)。
CREATE OR REPLACE FUNCTION dwh.run_daily_etl(p_target_date DATE DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_target       DATE;
  v_date_key     INT;
  v_lookback     DATE;
  v_lookback_key INT;
BEGIN
  v_target := COALESCE(p_target_date, (now() AT TIME ZONE 'Asia/Tokyo')::date - 1);
  v_date_key := to_char(v_target, 'YYYYMMDD')::int;
  v_lookback := v_target - 6;
  v_lookback_key := to_char(v_lookback, 'YYYYMMDD')::int;

  -- パーティションの防御的確保
  PERFORM ops.ensure_dialogue_partitions(3);
  PERFORM dwh.ensure_fact_partitions(3);

  -- ── ディメンション: SCD Type 2 ──────────────────────

  -- users: 変更行をクローズ
  UPDATE dwh.dim_user du
  SET valid_to = v_target - 1
  FROM ops.users u
  WHERE du.user_id = u.user_id
    AND du.valid_to = DATE '9999-12-31'
    AND (du.display_name <> u.display_name OR du.role <> u.role OR du.active <> u.active);

  -- users: 新規・変更後の現行行を追加
  INSERT INTO dwh.dim_user (user_id, display_name, role, active, valid_from)
  SELECT u.user_id, u.display_name, u.role, u.active, v_target
  FROM ops.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM dwh.dim_user du
    WHERE du.user_id = u.user_id AND du.valid_to = DATE '9999-12-31'
  );

  -- projects: 変更行をクローズ
  UPDATE dwh.dim_project dp
  SET valid_to = v_target - 1
  FROM ops.projects p
  LEFT JOIN ops.customers c ON c.customer_id = p.customer_id
  WHERE dp.project_id = p.project_id
    AND dp.valid_to = DATE '9999-12-31'
    AND (dp.project_name <> p.name
      OR dp.status <> p.status
      OR dp.customer_id IS DISTINCT FROM p.customer_id
      OR dp.customer_name IS DISTINCT FROM c.name
      OR dp.industry IS DISTINCT FROM c.industry);

  -- projects: 新規・変更後の現行行を追加
  INSERT INTO dwh.dim_project (project_id, project_name, project_type, customer_id, customer_name, industry, status, valid_from)
  SELECT p.project_id, p.name, p.project_type, p.customer_id, c.name, c.industry, p.status, v_target
  FROM ops.projects p
  LEFT JOIN ops.customers c ON c.customer_id = p.customer_id
  WHERE NOT EXISTS (
    SELECT 1 FROM dwh.dim_project dp
    WHERE dp.project_id = p.project_id AND dp.valid_to = DATE '9999-12-31'
  );

  -- ── fact_task_activity(タスク状態遷移粒度)───────────
  -- 注: dim_task_type は ops.tasks に分類フィールドがないため Phase 1 では NULL

  DELETE FROM dwh.fact_task_activity WHERE date_key = v_date_key;

  INSERT INTO dwh.fact_task_activity
    (date_key, user_key, project_key, task_id, status_from, status_to,
     lead_time_hours, estimated_hours, was_blocked)
  SELECT
    v_date_key,
    du.user_key,
    dp.project_key,
    l.task_id,
    l.status_from,
    l.status_to,
    CASE WHEN l.status_to = 'done'
         THEN round(EXTRACT(EPOCH FROM (l.changed_at - t.created_at)) / 3600.0, 2) END,
    (t.ai_decomposition ->> 'estimated_hours')::numeric,
    EXISTS (SELECT 1 FROM ops.task_status_log b
            WHERE b.task_id = l.task_id AND b.status_to = 'blocked')
  FROM ops.task_status_log l
  JOIN ops.tasks t ON t.task_id = l.task_id
  LEFT JOIN dwh.dim_user du
    ON du.user_id = t.assignee_id AND du.valid_to = DATE '9999-12-31'
  LEFT JOIN dwh.dim_project dp
    ON dp.project_id = t.project_id AND dp.valid_to = DATE '9999-12-31'
  WHERE (l.changed_at AT TIME ZONE 'Asia/Tokyo')::date = v_target;

  -- ── fact_dialogue(対話1セッション粒度)──────────────

  DELETE FROM dwh.fact_dialogue WHERE date_key = v_date_key;

  INSERT INTO dwh.fact_dialogue
    (date_key, user_key, project_key, dialogue_type_key, turn_count, user_response_chars,
     hypothesis_stated, hypothesis_ai_assisted, review_completed,
     model_used, input_tokens, output_tokens, cost_usd)
  SELECT
    v_date_key,
    du.user_key,
    dp.project_key,
    ddt.dialogue_type_key,
    jsonb_array_length(d.turns),
    (SELECT COALESCE(sum(length(t.elem ->> 'content')), 0)::int
     FROM jsonb_array_elements(d.turns) AS t(elem)
     WHERE t.elem ->> 'role' = 'user'),
    d.hypothesis IS NOT NULL,
    COALESCE((d.hypothesis ->> 'ai_assisted')::boolean, FALSE),
    d.review IS NOT NULL,
    d.model_used,
    d.input_tokens,
    d.output_tokens,
    d.cost_usd
  FROM ops.dialogues d
  JOIN dwh.dim_user du ON du.user_id = d.user_id AND du.valid_to = DATE '9999-12-31'
  LEFT JOIN dwh.dim_project dp ON dp.project_id = d.project_id AND dp.valid_to = DATE '9999-12-31'
  JOIN dwh.dim_dialogue_type ddt ON ddt.dialogue_type = d.dialogue_type
  WHERE (d.created_at AT TIME ZONE 'Asia/Tokyo')::date = v_target;

  -- ── fact_hypothesis_outcome(仮説→結果の突合)────────
  -- 朝の仮説と、同一対話の review またはそれ以降の completion_review を突合する。
  -- 振り返りが翌日以降に完了するケースを取り込むため、仮説表明日で直近7日を洗い替える
  -- (date_key は仮説表明日。days_to_outcome = 振り返り日 - 仮説表明日)。
  -- 7日を超えて完了した振り返りは突合対象外(運用上は同日〜数日内が前提)。

  DELETE FROM dwh.fact_hypothesis_outcome
  WHERE date_key BETWEEN v_lookback_key AND v_date_key;

  INSERT INTO dwh.fact_hypothesis_outcome
    (date_key, user_key, project_key, task_id, hypothesis_text, outcome_text,
     gap_category, next_change_stated, days_to_outcome)
  SELECT
    to_char((m.created_at AT TIME ZONE 'Asia/Tokyo')::date, 'YYYYMMDD')::int,
    du.user_key,
    dp.project_key,
    m.task_id,
    concat_ws(' / ',
      m.hypothesis ->> 'position',
      m.hypothesis ->> 'success_criteria',
      m.hypothesis ->> 'expected_obstacles'),
    r.review ->> 'actual_outcome',
    CASE WHEN r.review ->> 'gap_category' IN ('none','minor','major','opposite')
         THEN r.review ->> 'gap_category' END,
    NULLIF(trim(r.review ->> 'next_change'), '') IS NOT NULL,
    (r.created_at AT TIME ZONE 'Asia/Tokyo')::date
      - (m.created_at AT TIME ZONE 'Asia/Tokyo')::date
  FROM ops.dialogues m
  JOIN LATERAL (
    SELECT d2.review, d2.created_at
    FROM ops.dialogues d2
    WHERE d2.user_id = m.user_id
      AND d2.review IS NOT NULL
      AND d2.created_at >= m.created_at
      AND (d2.created_at AT TIME ZONE 'Asia/Tokyo')::date <= v_target
      AND ((d2.dialogue_id = m.dialogue_id AND d2.created_at = m.created_at)
           OR d2.dialogue_type = 'completion_review')
      AND (m.task_id IS NULL OR d2.task_id IS NULL OR d2.task_id = m.task_id)
      -- 振り返りは「直近の朝仮説」にのみ帰属させる:
      -- m と d2 の間により新しい朝の対話がある場合、この review は m とペアにしない
      -- (1つの review が複数日の仮説に二重帰属して outcomes が過大計上されるのを防ぐ)
      AND NOT EXISTS (
        SELECT 1 FROM ops.dialogues m2
        WHERE m2.user_id = m.user_id
          AND m2.dialogue_type = 'morning_checkin'
          AND m2.created_at > m.created_at
          AND m2.created_at <= d2.created_at
      )
    ORDER BY d2.created_at
    LIMIT 1
  ) r ON TRUE
  JOIN dwh.dim_user du ON du.user_id = m.user_id AND du.valid_to = DATE '9999-12-31'
  LEFT JOIN dwh.dim_project dp ON dp.project_id = m.project_id AND dp.valid_to = DATE '9999-12-31'
  WHERE m.dialogue_type = 'morning_checkin'
    AND m.hypothesis IS NOT NULL
    AND (m.created_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN v_lookback AND v_target;

  -- ── fact_ai_suggestion(採否は後日確定しうるため直近7日を洗い替え)──

  DELETE FROM dwh.fact_ai_suggestion
  WHERE date_key BETWEEN v_lookback_key AND v_date_key;

  INSERT INTO dwh.fact_ai_suggestion
    (date_key, user_key, project_key, category, decision, decision_reason_stated, hours_to_decision)
  SELECT
    to_char((s.created_at AT TIME ZONE 'Asia/Tokyo')::date, 'YYYYMMDD')::int,
    du.user_key,
    dp.project_key,
    s.category,
    s.user_decision,
    s.decision_reason IS NOT NULL AND trim(s.decision_reason) <> '',
    round(EXTRACT(EPOCH FROM (s.decided_at - s.created_at)) / 3600.0, 2)
  FROM ops.suggestions s
  JOIN dwh.dim_user du ON du.user_id = s.user_id AND du.valid_to = DATE '9999-12-31'
  LEFT JOIN ops.tasks t ON t.task_id = s.task_id
  LEFT JOIN dwh.dim_project dp ON dp.project_id = t.project_id AND dp.valid_to = DATE '9999-12-31'
  WHERE (s.created_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN v_lookback AND v_target;

  -- ── fact_workload(日次スナップショット: UPSERT)──────

  INSERT INTO dwh.fact_workload
    (date_key, user_key, open_tasks, in_progress_tasks, blocked_tasks, overdue_tasks,
     checkin_completed, review_completed)
  SELECT
    v_date_key,
    du.user_key,
    count(t.task_id) FILTER (WHERE t.status IN ('proposed', 'approved')),
    count(t.task_id) FILTER (WHERE t.status = 'in_progress'),
    count(t.task_id) FILTER (WHERE t.status = 'blocked'),
    count(t.task_id) FILTER (WHERE t.status NOT IN ('done', 'cancelled') AND t.due_date < v_target),
    EXISTS (SELECT 1 FROM ops.dialogues d
            WHERE d.user_id = du.user_id
              AND d.dialogue_type = 'morning_checkin'
              AND d.hypothesis IS NOT NULL
              AND (d.created_at AT TIME ZONE 'Asia/Tokyo')::date = v_target),
    EXISTS (SELECT 1 FROM ops.dialogues d
            WHERE d.user_id = du.user_id
              AND d.review IS NOT NULL
              AND (d.created_at AT TIME ZONE 'Asia/Tokyo')::date = v_target)
  FROM dwh.dim_user du
  LEFT JOIN ops.tasks t ON t.assignee_id = du.user_id
  WHERE du.valid_to = DATE '9999-12-31' AND du.active
  GROUP BY du.user_key, du.user_id
  ON CONFLICT (date_key, user_key) DO UPDATE SET
    open_tasks        = EXCLUDED.open_tasks,
    in_progress_tasks = EXCLUDED.in_progress_tasks,
    blocked_tasks     = EXCLUDED.blocked_tasks,
    overdue_tasks     = EXCLUDED.overdue_tasks,
    checkin_completed = EXCLUDED.checkin_completed,
    review_completed  = EXCLUDED.review_completed;

  -- ── fact_escalation(解決は後日のため直近7日を洗い替え)──

  DELETE FROM dwh.fact_escalation
  WHERE date_key BETWEEN v_lookback_key AND v_date_key;

  INSERT INTO dwh.fact_escalation
    (date_key, raised_reason, related_user_key, related_project_key, hours_to_resolve, knowledge_reflected)
  SELECT
    to_char((e.created_at AT TIME ZONE 'Asia/Tokyo')::date, 'YYYYMMDD')::int,
    e.reason,
    du.user_key,
    dp.project_key,
    round(EXTRACT(EPOCH FROM (e.resolved_at - e.created_at)) / 3600.0, 2),
    e.knowledge_reflected
  FROM ops.escalations e
  LEFT JOIN dwh.dim_user du ON du.user_id = e.related_user_id AND du.valid_to = DATE '9999-12-31'
  LEFT JOIN ops.tasks t ON t.task_id = e.related_task_id
  LEFT JOIN dwh.dim_project dp ON dp.project_id = t.project_id AND dp.valid_to = DATE '9999-12-31'
  WHERE (e.created_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN v_lookback AND v_target;
END;
$$;

-- SECURITY DEFINER 関数の実行権限は既定(PUBLIC)から剥奪し、必要なロールにのみ付与する
-- (付与は 30_grants.sql — ロールが存在する環境でのみ付与)。
REVOKE EXECUTE ON FUNCTION dwh.run_daily_etl(DATE) FROM PUBLIC;
