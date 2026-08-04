-- Track the last time we reconciled a session's chat history from OpenWA.
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
