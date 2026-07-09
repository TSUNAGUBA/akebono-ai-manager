-- 利用ユーザーの初期登録テンプレート(要件 3: ロールA=admin 2名 / ロールB=member 3名)
-- 値を自社メンバーに置き換えて psql で実行する:
--   psql "host=<RDS_HOST> dbname=ai_manager user=<ADMIN_USER> sslmode=require" -f seed-users.sample.sql
--
-- ON CONFLICT により再実行安全。chat_space_id は本人が Chat アプリに
-- 最初に話しかけた時点で自動登録されるため、ここでは設定不要。

INSERT INTO ops.users (user_id, display_name, email, role) VALUES
  ('admin-001',  '山下',  'yamashita@example.co.jp', 'admin'),
  ('admin-002',  '副責任者', 'fuku@example.co.jp',    'admin'),
  ('member-001', '田中',  'tanaka@example.co.jp',    'member'),
  ('member-002', '佐藤',  'sato@example.co.jp',      'member'),
  ('member-003', '鈴木',  'suzuki@example.co.jp',    'member')
ON CONFLICT (user_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  email        = EXCLUDED.email,
  role         = EXCLUDED.role;
