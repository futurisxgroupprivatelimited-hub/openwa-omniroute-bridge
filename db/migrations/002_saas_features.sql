-- 002_saas_features.sql — admin role, LLM gateway settings, notifications, session health, catch-up
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS admin_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES wa_sessions(id) ON DELETE CASCADE,
  type        text NOT NULL DEFAULT 'system',
  level       text NOT NULL DEFAULT 'info',
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS remote_id text;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_remote ON messages(remote_id);
