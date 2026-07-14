-- v0.12 追補: エスカレーション解決導線・対話フィードバック・プロジェクトナレッジ
--
-- 1) ops.escalations に解決種別(resolution_type)を追加する。
--    ダッシュボードの解決アクション(v0.12 §3)で「裁定(ナレッジ還流)/メンバーへの回答送信/
--    回答不要」を区別する。既存の解決済み行はすべて Chat の裁定フローによるものなので
--    'ruling' へバックフィルする(下位互換 — 開発原則 7。以後の裁定も 'ruling' を設定する)。
ALTER TABLE ops.escalations
  ADD COLUMN resolution_type TEXT CHECK (resolution_type IN ('ruling', 'admin_message', 'no_action'));

COMMENT ON COLUMN ops.escalations.resolution_type IS
  '解決の種別(任意): ruling=裁定(decision_rules へ還流) / admin_message=メンバーへの回答送信 / no_action=回答不要。NULL は v0.12 以前の未分類(裁定)';

UPDATE ops.escalations
   SET resolution_type = 'ruling'
 WHERE status = 'resolved' AND resolution_type IS NULL;

-- 2) ops.dialogues の dialogue_type に 'feedback_correction' を追加する(0006 と同じ手順)。
--    管理者フィードバックを受けて AI が本人へ送る「謝罪+訂正」メッセージの対話種別。
--    既存値はすべて新しい許可リストに含まれるため、既存データへの影響はない(下位互換)。
ALTER TABLE ops.dialogues
  DROP CONSTRAINT dialogues_dialogue_type_check;
ALTER TABLE ops.dialogues
  ADD CONSTRAINT dialogues_dialogue_type_check CHECK (dialogue_type IN
    ('morning_checkin','completion_review','adhoc_qa','task_instruction','escalation',
     'adhoc_checkin','feedback_correction'));

-- dwh.dim_dialogue_type への追加(0006 と対。ディメンション行がないと
-- fact_dialogue の INNER JOIN から feedback_correction の対話が静かに欠落する)
INSERT INTO dwh.dim_dialogue_type (dialogue_type) VALUES ('feedback_correction')
ON CONFLICT (dialogue_type) DO NOTHING;

-- 3) 対話フィードバック(v0.12 §7)。
--    SoT はこのテーブル。rag.knowledge_chunks の doc_id='feedback/{id}' チャンクは
--    ここからの還流キャッシュ(ADR-11 の裁定還流と同じパターン)。
--    ops.dialogues は複合 PK(dialogue_id, created_at)のパーティション表のため
--    FK は張れず、両列を保持して参照する(パーティション分割の制約として記録)。
CREATE TABLE ops.dialogue_feedback (
  feedback_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dialogue_id            BIGINT NOT NULL,
  dialogue_created_at    TIMESTAMPTZ NOT NULL,
  user_id                TEXT NOT NULL REFERENCES ops.users(user_id),  -- 訂正を届ける本人(対象対話の相手)
  feedback               TEXT NOT NULL,                                -- 管理者による正しい回答・指摘
  created_by             TEXT NOT NULL REFERENCES ops.users(user_id),  -- フィードバックした管理者
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  knowledge_reflected    BOOLEAN NOT NULL DEFAULT FALSE,               -- rag への還流済みフラグ
  correction_dialogue_id BIGINT,                                       -- 送信した訂正メッセージの対話 ID
  delivered_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dialogue_feedback_dialogue ON ops.dialogue_feedback (dialogue_id);
CREATE INDEX idx_dialogue_feedback_status ON ops.dialogue_feedback (status);

COMMENT ON TABLE ops.dialogue_feedback IS
  'AI 回答への管理者フィードバック(v0.12)。pending=訂正メッセージ未送達(再送可能) / delivered=送達済み。還流チャンクは doc_id=feedback/{feedback_id}';

-- 4) プロジェクトナレッジ(v0.12 §4)。
--    Drive フォルダ規約 project/{プロジェクトID}/ の文書を doc_type='project_doc' として
--    プロジェクトに帰属させる(0004 の industry_id 追加と同じパターン)。
ALTER TABLE rag.knowledge_chunks ADD COLUMN project_id TEXT;
CREATE INDEX idx_knowledge_chunks_project ON rag.knowledge_chunks (project_id);

ALTER TABLE rag.knowledge_chunks
  DROP CONSTRAINT knowledge_chunks_doc_type_check;
ALTER TABLE rag.knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_doc_type_check CHECK (doc_type IN
    ('customer_profile','glossary','domain_ops','decision_rules','analogy','project_doc'));

COMMENT ON COLUMN rag.knowledge_chunks.project_id IS
  'プロジェクト固有ナレッジ(doc_type=project_doc)の帰属先。フォルダ規約 project/{プロジェクトID}/ から分類(マスタ突合は knowledge-sync)';
