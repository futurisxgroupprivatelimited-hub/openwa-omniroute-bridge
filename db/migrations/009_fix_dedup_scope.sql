-- Correct the dedup index scope: two users may share one OpenWA session and see
-- the same WhatsApp remote_id, so uniqueness must be per (user_id, remote_id).
DROP INDEX IF EXISTS idx_messages_remote_dedup;

DELETE FROM messages a
USING messages b
WHERE a.remote_id = b.remote_id
  AND a.user_id = b.user_id
  AND a.remote_id IS NOT NULL
  AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_remote_dedup
  ON messages(user_id, remote_id) WHERE remote_id IS NOT NULL;
