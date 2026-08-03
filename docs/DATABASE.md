# OpenBridge SaaS — Database Schema

All tables are tenant-scoped via `user_id`. Migrations live in `db/migrations/` and run in order
on container boot.

## Table: users

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| email | text UNIQUE NOT NULL | login |
| password_hash | text NOT NULL | bcrypt cost 10 |
| name | text | display |
| plan | text | free/pro (gating future) |
| api_key | text UNIQUE | programmatic access |
| webhook_token | text UNIQUE NOT NULL | 48 hex chars — identity of inbound webhooks |
| webhook_secret | text | optional HMAC secret for OpenWA webhooks |
| openwa_base_url | text | tenant's OpenWA address |
| openwa_api_key | text | tenant's OpenWA API key |
| model | text | primary LLM model |
| fallback_model | text | fallback model |
| memory_limit | int | history messages fetched per chat |
| max_tokens | int | LLM response cap |
| reply_hard_cap | int | reply char cap |
| default_character_id | uuid | FK characters |
| typing | jsonb | global typing timings |
| webhooks_auto_register | bool | auto-register on new sessions |
| created_at / updated_at | timestamptz | |

## Table: characters

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users CASCADE | tenant |
| name | text NOT NULL | |
| slug | text NOT NULL | per-user unique → `/webhook/<token>/<slug>` |
| tagline / greeting / bio / personality / reply_style / extra_rules | text | persona fields |
| languages | text[] | default `{English}` |
| tags | text[] | |
| visibility | text | public/private/unlisted |
| active | bool | |
| example_messages | jsonb | few-shot dialogue |
| typing_profile | jsonb | per-character typing |
| created_at / updated_at | timestamptz | |

`UNIQUE (user_id, slug)`.

## Table: wa_sessions

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users CASCADE | tenant |
| openwa_session_id | text NOT NULL | id reported by tenant OpenWA |
| name | text | |
| phone | text | |
| status | text | ready / qr_ready / … |
| character_id | uuid FK characters SET NULL | the character this session answers as |
| last_seen | timestamptz | |
| webhook_registered | bool | |
| created_at / updated_at | timestamptz | |

`UNIQUE (user_id, openwa_session_id)`.

## Table: chat_routing

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users CASCADE | |
| chat_id | text NOT NULL | WhatsApp chat id |
| character_id | uuid FK characters CASCADE | |
| created_at | timestamptz | |

`UNIQUE (user_id, chat_id)`.

## Table: messages

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users CASCADE | |
| session_id | uuid FK wa_sessions SET NULL | |
| chat_id | text NOT NULL | |
| direction | text CHECK (incoming/outgoing) | |
| body | text NOT NULL | |
| character_id | uuid FK characters SET NULL | who replied |
| created_at | timestamptz | |

`INDEX (user_id, chat_id, created_at DESC)` — powers per-chat history + dashboard.

## Routing resolution

Webhook slug → `wa_sessions.character_id` → `chat_routing[chat_id]` → `users.default_character_id`.
