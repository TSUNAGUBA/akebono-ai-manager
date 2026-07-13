-- v0.10 追補: プロジェクトの計画情報(内容・目的・マイルストーン)(要件 v0.10 §2)
-- すべてのプロジェクトが詳細に計画されているとは限らないため、全て任意項目とする。
--
-- データ境界(v0.10 §5): マイルストーンは「プロジェクトのみ」に属する
-- (タスク・顧客には紐づけない)。タスクとプロジェクトの関係は既存の
-- ops.tasks.project_id(任意 FK)のまま変更しない。

ALTER TABLE ops.projects ADD COLUMN description TEXT;
ALTER TABLE ops.projects ADD COLUMN objective TEXT;

COMMENT ON COLUMN ops.projects.description IS
  'プロジェクトの内容(任意)。AI 対話の文脈として供給される';
COMMENT ON COLUMN ops.projects.objective IS
  'プロジェクトの目的(任意)。AI 対話の文脈として供給される';

CREATE TABLE ops.project_milestones (
  milestone_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES ops.projects(project_id),
  title        TEXT NOT NULL,
  due_date     DATE,                              -- 任意(期日未定のマイルストーンを許容)
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_project_milestones_project ON ops.project_milestones (project_id);

COMMENT ON TABLE ops.project_milestones IS
  'プロジェクトのマイルストーン(任意)。プロジェクトにのみ属する(タスク・顧客とは独立)。管理はダッシュボードのプロジェクト編集から。AI 対話の文脈として供給される';
