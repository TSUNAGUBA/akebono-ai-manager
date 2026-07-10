-- v0.5 管理者発火の状況確認: dialogue_type に 'adhoc_checkin' を追加する。
--
-- 1) ops.dialogues の CHECK 制約の拡張(既存値+'adhoc_checkin')。
--    制約名は 0001 のインライン CHECK に PostgreSQL が自動命名した
--    dialogues_dialogue_type_check。パーティション親への ALTER は全パーティションに伝播する。
--    既存値はすべて新しい許可リストに含まれるため、既存データへの影響はない(下位互換)。
ALTER TABLE ops.dialogues
  DROP CONSTRAINT dialogues_dialogue_type_check;
ALTER TABLE ops.dialogues
  ADD CONSTRAINT dialogues_dialogue_type_check CHECK (dialogue_type IN
    ('morning_checkin','completion_review','adhoc_qa','task_instruction','escalation','adhoc_checkin'));

-- 2) dwh.dim_dialogue_type への追加。
--    日次 ETL(dwh.run_daily_etl)の fact_dialogue は dim_dialogue_type と INNER JOIN するため、
--    ディメンション行がないと adhoc_checkin の対話がファクトから静かに欠落する(0003 の初期投入と対)。
INSERT INTO dwh.dim_dialogue_type (dialogue_type) VALUES ('adhoc_checkin')
ON CONFLICT (dialogue_type) DO NOTHING;
