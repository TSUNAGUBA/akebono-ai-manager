-- M6 裁定のナレッジ還流: 「裁定を記録」ボタン押下〜管理者の次メッセージ受領までの
-- 待ち状態を保持するカラムを追加する(suggestions の「理由待ち」パターンの escalation 版)。
-- 追加のみの下位互換変更: 既存行は NULL(= 記録待ちなし)のままで影響しない。

ALTER TABLE ops.escalations
  ADD COLUMN resolution_requested_by TEXT REFERENCES ops.users(user_id),
  ADD COLUMN resolution_requested_at TIMESTAMPTZ;
