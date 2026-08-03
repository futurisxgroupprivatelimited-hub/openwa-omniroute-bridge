-- 001_init.sql — OpenBridge SaaS core schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text UNIQUE NOT NULL,
  password_hash         text NOT NULL,
  name                  text NOT NULL DEFAULT '',
  plan                  text NOT NULL DEFAULT 'free',
  api_key               text UNIQUE,
  webhook_token         text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  webhook_secret        text,
  openwa_base_url       text,
  openwa_api_key        text,
  model                 text NOT NULL DEFAULT 'big-pickle',
  fallback_model        text NOT NULL DEFAULT 'auto',
  memory_limit          int NOT NULL DEFAULT 40,
  max_tokens            int NOT NULL DEFAULT 80,
  reply_hard_cap        int NOT NULL DEFAULT 120,
  default_character_id  uuid,
  typing                jsonb NOT NULL DEFAULT '{"enabled":true,"readDelayMs":[2000,5000],"falseStartChance":0.35,"minTypingMs":2000,"maxTypingMs":8000}',
  webhooks_auto_register boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  slug              text NOT NULL,
  tagline           text NOT NULL DEFAULT '',
  greeting          text NOT NULL DEFAULT '',
  bio               text NOT NULL DEFAULT '',
  personality       text NOT NULL DEFAULT '',
  reply_style       text NOT NULL DEFAULT '',
  extra_rules       text NOT NULL DEFAULT '',
  languages         text[] NOT NULL DEFAULT ARRAY['English'],
  tags              text[] NOT NULL DEFAULT '{}',
  visibility        text NOT NULL DEFAULT 'private',
  active            boolean NOT NULL DEFAULT true,
  example_messages  jsonb NOT NULL DEFAULT '[]',
  typing_profile    jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS wa_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  openwa_session_id   text NOT NULL,
  name                text NOT NULL DEFAULT '',
  phone               text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'unknown',
  character_id        uuid REFERENCES characters(id) ON DELETE SET NULL,
  last_seen           timestamptz,
  webhook_registered  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, openwa_session_id)
);

CREATE TABLE IF NOT EXISTS chat_routing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id       text NOT NULL,
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES wa_sessions(id) ON DELETE SET NULL,
  chat_id       text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  body          text NOT NULL,
  character_id  uuid REFERENCES characters(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_user_chat ON messages(user_id, chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_user ON wa_sessions(user_id);
