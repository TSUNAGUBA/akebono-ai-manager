-- v0.8 追補: AI からの問いかけ配信可否のユーザー単位設定(要件 v0.8 §3)
-- 従来はロール(role = 'member')で問いかけ対象を固定していたが、ユーザー単位の
-- フラグ(checkin_enabled)に置き換える。
--
-- 既存ユーザーの初期値は従来動作を保存する(下位互換・開発原則 7):
--   member → TRUE(従来どおり問いかけ対象) / admin → FALSE(従来どおり対象外)
-- 新規ユーザーの既定値は TRUE(ロールに関わらず問いかけ対象。不要なら管理 UI で無効化)。
-- 初期値の設定は versioned マイグレーションとして一度だけ実行されるため、
-- 適用後にダッシュボードで変更した設定が再実行で巻き戻ることはない(開発原則 2)。

ALTER TABLE ops.users ADD COLUMN checkin_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE ops.users SET checkin_enabled = (role = 'member');

COMMENT ON COLUMN ops.users.checkin_enabled IS
  'AI からの問いかけ(朝の問いかけ・状況確認)の配信可否。ダッシュボードのユーザー設定(/admin/users)から管理者が変更する';
