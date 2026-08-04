-- 004_playground_history.sql — persisted playground conversations + live chat history browser
CREATE TABLE IF NOT EXISTS playground_chats (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user','assistant')),
  content       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playground_chats_char ON playground_chats(user_id, character_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_char_chat ON messages(user_id, character_id, chat_id, created_at);
