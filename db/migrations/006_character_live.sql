-- 006_character_live.sql — avatars + last-activity tracking for the character dashboard
ALTER TABLE characters ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_characters_last_active ON characters(user_id, last_active_at DESC);
