-- dwh スキーマ: スタースキーマ(要件 7.3)
-- ②層の成長観察(仮説→結果の突合)は時点スナップショットの蓄積が本質のため、
-- ビューではなく履歴を持つファクトテーブルとして実体化する。

CREATE SCHEMA IF NOT EXISTS dwh;

-- ── ディメンション ──────────────────────────

CREATE TABLE dwh.dim_user (
  user_key     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  active       BOOLEAN NOT NULL,
  valid_from   DATE NOT NULL,
  valid_to     DATE NOT NULL DEFAULT '9999-12-31'   -- SCD Type 2
);
CREATE INDEX idx_dim_user_nk ON dwh.dim_user (user_id, valid_to);

CREATE TABLE dwh.dim_project (
  project_key   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  project_type  TEXT NOT NULL,
  customer_id   TEXT,
  customer_name TEXT,
  industry      TEXT,
  status        TEXT NOT NULL,
  valid_from    DATE NOT NULL,
  valid_to      DATE NOT NULL DEFAULT '9999-12-31'
);
CREATE INDEX idx_dim_project_nk ON dwh.dim_project (project_id, valid_to);

CREATE TABLE dwh.dim_date (
  date_key        INT PRIMARY KEY,        -- YYYYMMDD
  full_date       DATE NOT NULL UNIQUE,
  year            INT NOT NULL,
  quarter         INT NOT NULL,
  month           INT NOT NULL,
  week_of_year    INT NOT NULL,
  day_of_week     INT NOT NULL,
  is_business_day BOOLEAN NOT NULL        -- 土日のみ考慮(祝日は将来対応)
);

-- 10年分を初期投入(2024-01-01 〜 2033-12-31)
INSERT INTO dwh.dim_date (date_key, full_date, year, quarter, month, week_of_year, day_of_week, is_business_day)
SELECT
  to_char(d, 'YYYYMMDD')::int,
  d,
  EXTRACT(YEAR FROM d)::int,
  EXTRACT(QUARTER FROM d)::int,
  EXTRACT(MONTH FROM d)::int,
  EXTRACT(WEEK FROM d)::int,
  EXTRACT(DOW FROM d)::int,
  EXTRACT(DOW FROM d) NOT IN (0, 6)
FROM generate_series(DATE '2024-01-01', DATE '2033-12-31', INTERVAL '1 day') AS s(d);

CREATE TABLE dwh.dim_task_type (
  task_type_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      TEXT NOT NULL,   -- development / proposal / operation / adjustment / inventory ...
  subcategory   TEXT
);

CREATE TABLE dwh.dim_dialogue_type (
  dialogue_type_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dialogue_type     TEXT NOT NULL UNIQUE
);

INSERT INTO dwh.dim_dialogue_type (dialogue_type) VALUES
  ('morning_checkin'), ('completion_review'), ('adhoc_qa'), ('task_instruction'), ('escalation');

-- ── ファクト ────────────────────────────────

-- タスク状態遷移粒度
CREATE TABLE dwh.fact_task_activity (
  task_activity_key BIGINT GENERATED ALWAYS AS IDENTITY,
  date_key          INT NOT NULL,
  user_key          BIGINT REFERENCES dwh.dim_user(user_key),
  project_key       BIGINT REFERENCES dwh.dim_project(project_key),
  task_type_key     BIGINT REFERENCES dwh.dim_task_type(task_type_key),
  task_id           BIGINT NOT NULL,
  status_from       TEXT,
  status_to         TEXT NOT NULL,
  lead_time_hours   NUMERIC(10,2),
  estimated_hours   NUMERIC(10,2),
  was_blocked       BOOLEAN,
  PRIMARY KEY (task_activity_key, date_key)
) PARTITION BY RANGE (date_key);

-- 対話1セッション粒度
CREATE TABLE dwh.fact_dialogue (
  dialogue_key           BIGINT GENERATED ALWAYS AS IDENTITY,
  date_key               INT NOT NULL,
  user_key               BIGINT NOT NULL,
  project_key            BIGINT,
  dialogue_type_key      BIGINT NOT NULL,
  turn_count             INT NOT NULL,
  user_response_chars    INT,        -- 回答の量(深さの代理指標の一つ)
  hypothesis_stated      BOOLEAN,    -- 本人が仮説を表明したか
  hypothesis_ai_assisted BOOLEAN,    -- AI補助で仮説化したか
  review_completed       BOOLEAN,
  model_used             TEXT,
  input_tokens           INT,
  output_tokens          INT,
  cost_usd               NUMERIC(10,6),
  PRIMARY KEY (dialogue_key, date_key)
) PARTITION BY RANGE (date_key);

-- 仮説→結果の突合粒度(②層の成長観察の中核)
CREATE TABLE dwh.fact_hypothesis_outcome (
  hypothesis_key      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key            INT NOT NULL,          -- 仮説表明日
  user_key            BIGINT NOT NULL,
  project_key         BIGINT,
  task_id             BIGINT,
  hypothesis_text     TEXT,
  outcome_text        TEXT,
  gap_category        TEXT CHECK (gap_category IN ('none','minor','major','opposite')),
    -- AI(夕バッチ)が分類し ops.dialogues.review に書き戻した値を取り込む
  next_change_stated  BOOLEAN,               -- 「次に変えること」を言語化できたか
  days_to_outcome     INT
);
CREATE INDEX idx_fact_hypothesis_user ON dwh.fact_hypothesis_outcome (user_key, date_key);

-- AI提案の採否粒度
CREATE TABLE dwh.fact_ai_suggestion (
  suggestion_key         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key               INT NOT NULL,
  user_key               BIGINT NOT NULL,
  project_key            BIGINT,
  category               TEXT NOT NULL,
  decision               TEXT,               -- accepted / rejected / modified / ignored
  decision_reason_stated BOOLEAN,
  hours_to_decision      NUMERIC(10,2)
);
CREATE INDEX idx_fact_suggestion_user ON dwh.fact_ai_suggestion (user_key, date_key);

-- 日次スナップショット粒度
CREATE TABLE dwh.fact_workload (
  date_key           INT NOT NULL,
  user_key           BIGINT NOT NULL,
  open_tasks         INT NOT NULL,
  in_progress_tasks  INT NOT NULL,
  blocked_tasks      INT NOT NULL,
  overdue_tasks      INT NOT NULL,
  checkin_completed  BOOLEAN NOT NULL,       -- 朝の問答実施
  review_completed   BOOLEAN NOT NULL,       -- 夕の問答実施
  PRIMARY KEY (date_key, user_key)
);

CREATE TABLE dwh.fact_escalation (
  escalation_key      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_key            INT NOT NULL,
  raised_reason       TEXT NOT NULL,
  related_user_key    BIGINT,
  related_project_key BIGINT,
  hours_to_resolve    NUMERIC(10,2),
  knowledge_reflected BOOLEAN                -- ナレッジ還流率のKPI元
);

-- date_key(YYYYMMDD)レンジの月次パーティション自動作成
CREATE OR REPLACE FUNCTION dwh.ensure_fact_partitions(p_months_ahead INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_table TEXT;
  v_start DATE;
  v_name  TEXT;
  i       INT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['fact_task_activity', 'fact_dialogue'] LOOP
    -- i = -1(前月)から作成する(ops.ensure_dialogue_partitions と同じ月境界対策)
    FOR i IN -1..p_months_ahead LOOP
      v_start := date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date) + make_interval(months => i);
      v_name  := v_table || '_' || to_char(v_start, 'YYYYMM');
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'dwh' AND c.relname = v_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE dwh.%I PARTITION OF dwh.%I FOR VALUES FROM (%s) TO (%s)',
          v_name, v_table,
          to_char(v_start, 'YYYYMMDD'),
          to_char(v_start + INTERVAL '1 month', 'YYYYMMDD')
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

SELECT dwh.ensure_fact_partitions(3);
