-- ops スキーマ: 運用系(要件 7.2)
-- タスク、対話、提案、エスカレーション、レポート

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE ops.users (
  user_id        TEXT PRIMARY KEY,            -- Google Workspace のユーザーID
  display_name   TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  chat_space_id  TEXT,                        -- DMスペースID(ADDED_TO_SPACE で自動設定)
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.customers (
  customer_id               TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  industry                  TEXT NOT NULL CHECK (industry IN
    ('apparel_retail','apparel_maker','zakka','bedding','logistics','other')),
  knowledge_drive_folder_id TEXT,
  notes                     TEXT
);

CREATE TABLE ops.projects (
  project_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  customer_id    TEXT REFERENCES ops.customers(customer_id),
  project_type   TEXT NOT NULL CHECK (project_type IN
    ('si','saas','media','utsuwa','internal')),
  status         TEXT NOT NULL DEFAULT 'active',
  priority       INT,
  admin_owner_id TEXT REFERENCES ops.users(user_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ops.tasks (
  task_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        TEXT REFERENCES ops.projects(project_id),
  title             TEXT NOT NULL,
  description       TEXT,
  assignee_id       TEXT REFERENCES ops.users(user_id),
  requester_id      TEXT REFERENCES ops.users(user_id),  -- 指示した管理者
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','approved','in_progress','blocked','done','cancelled')),
  ai_decomposition  JSONB,      -- { subtasks: [], estimated_hours, suggested_deadline }
  approved_by       TEXT REFERENCES ops.users(user_id),
  due_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX idx_tasks_assignee_status ON ops.tasks (assignee_id, status);
CREATE INDEX idx_tasks_project ON ops.tasks (project_id);

-- タスク状態遷移の履歴(fact_task_activity の源泉)
CREATE TABLE ops.task_status_log (
  log_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      BIGINT NOT NULL REFERENCES ops.tasks(task_id),
  status_from  TEXT,
  status_to    TEXT NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_via  TEXT NOT NULL DEFAULT 'dialogue'  -- dialogue / admin / system
);
CREATE INDEX idx_task_status_log_changed ON ops.task_status_log (changed_at);

-- 対話ログ(全件構造化保存。M4/M5 の入力)
CREATE TABLE ops.dialogues (
  dialogue_id    BIGINT GENERATED ALWAYS AS IDENTITY,
  user_id        TEXT NOT NULL REFERENCES ops.users(user_id),
  task_id        BIGINT,
  project_id     TEXT,
  dialogue_type  TEXT NOT NULL CHECK (dialogue_type IN
    ('morning_checkin','completion_review','adhoc_qa','task_instruction','escalation')),
  turns          JSONB NOT NULL DEFAULT '[]',
    -- [ { role: 'ai'|'user', content, ts } ]
  hypothesis     JSONB,
    -- { position, success_criteria, expected_obstacles, ai_assisted: bool }
  review         JSONB,
    -- { actual_outcome, gap_analysis, next_change, gap_category }
  model_used     TEXT,
  input_tokens   INT,
  output_tokens  INT,
  cost_usd       NUMERIC(10,6),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dialogue_id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_dialogues_user_date ON ops.dialogues (user_id, created_at);

-- AI 提案と採否(採否と理由がチームの知恵になる)
CREATE TABLE ops.suggestions (
  suggestion_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dialogue_id      BIGINT,
  user_id          TEXT NOT NULL REFERENCES ops.users(user_id),
  task_id          BIGINT,
  content          TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN
    ('next_action','decomposition','priority','knowledge')),
  user_decision    TEXT CHECK (user_decision IN
    ('accepted','rejected','modified','ignored')),
  decision_reason  TEXT,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_suggestions_user ON ops.suggestions (user_id, created_at);

-- エスカレーション(M6)。裁定結果はナレッジへ還流する
CREATE TABLE ops.escalations (
  escalation_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reason              TEXT NOT NULL CHECK (reason IN
    ('low_confidence','customer_impact','member_anomaly','priority_conflict')),
  context             TEXT NOT NULL,
  related_task_id     BIGINT,
  related_user_id     TEXT REFERENCES ops.users(user_id),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution          TEXT,
  resolved_by         TEXT REFERENCES ops.users(user_id),
  resolved_at         TIMESTAMPTZ,
  knowledge_reflected BOOLEAN NOT NULL DEFAULT FALSE,  -- ナレッジ還流済みフラグ
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 日報・週報(M4)。confirmed_by_user は再生成で巻き戻さないこと(状態保護)
CREATE TABLE ops.reports (
  report_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type        TEXT NOT NULL CHECK (report_type IN ('daily','weekly_admin')),
  user_id            TEXT REFERENCES ops.users(user_id),
  report_date        DATE NOT NULL,
  content            TEXT NOT NULL,
  confirmed_by_user  BOOLEAN NOT NULL DEFAULT FALSE,
  source_dialogue_ids BIGINT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_type, user_id, report_date)
);

-- 月次パーティション自動作成(pg_cron から月次で呼び出し、ETL からも防御的に呼ぶ)
CREATE OR REPLACE FUNCTION ops.ensure_dialogue_partitions(p_months_ahead INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE;
  v_end   DATE;
  v_name  TEXT;
  i       INT;
BEGIN
  -- i = -1(前月)から作成する: JST と UTC の月が異なる月初 00:00〜09:00 JST に
  -- 初回実行しても、直前の UTC 月のパーティションが欠けないようにするため
  FOR i IN -1..p_months_ahead LOOP
    v_start := date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date) + make_interval(months => i);
    v_end   := v_start + INTERVAL '1 month';
    v_name  := 'dialogues_' || to_char(v_start, 'YYYYMM');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ops' AND c.relname = v_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE ops.%I PARTITION OF ops.dialogues FOR VALUES FROM (%L) TO (%L)',
        v_name, v_start, v_end
      );
    END IF;
  END LOOP;
END;
$$;

SELECT ops.ensure_dialogue_partitions(3);
