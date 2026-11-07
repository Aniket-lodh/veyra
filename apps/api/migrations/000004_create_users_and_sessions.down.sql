-- 000004_create_users_and_sessions.down.sql
ALTER TABLE api_keys DROP COLUMN IF EXISTS created_by_user_id;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
