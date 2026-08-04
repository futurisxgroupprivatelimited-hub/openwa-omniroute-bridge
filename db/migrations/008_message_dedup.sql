-- De-duplicate mirrored messages and enforce idempotent persistence.
-- The reconnect/periodic sync and the live webhook path can both try to insert
-- the same inbound message (same WhatsApp id) FOR THE SAME USER. Two users may
-- share one OpenWA session and therefore see identical remote_ids, so the unique
-- index must be scoped per (user_id, remote_id) — not remote_id alone.
DELETE FROM messages a
USING messages b
WHERE a.remote_id = b.remote_id
  AND a.user_id = b.user_id
  AND a.remote_id IS NOT NULL
  AND a.created_at > b.created_at;

DELETE FROM messages a
USING messages b
WHERE a.remote_id = b.remote_id
  AND a.user_id = b.user_id
  AND a.remote_id IS NOT NULL
  AND a.created_at = b.created_at
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_remote_dedup
  ON messages(user_id, remote_id) WHERE remote_id IS NOT NULL;

DROP INDEX IF EXISTS idx_messages_remote_dedup_global;
