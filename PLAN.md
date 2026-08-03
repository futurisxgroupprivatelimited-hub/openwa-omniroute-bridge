# OpenBridge — Multi-Tenant WhatsApp AI SaaS (v2.0)

Turn any number of WhatsApp numbers (each a **tenant**) into conversational AI characters,
with per-user webhooks, PostgreSQL persistence, and pluggable per-tenant OpenWA + a shared OmniRoute LLM gateway.

---

## 1. Vision

- **Multi-tenant** by default: one bridge instance, many accounts, full isolation.
- Each account gets its own **authenticated webhook URL** — no shared secrets.
- Characters, WhatsApp sessions, chat routing, and message history live in **Postgres**, per user.
- Tenants bring their own **OpenWA** instance (and API key); the bridge calls out to it on their behalf.
- Shared **OmniRoute** LLM gateway keeps costs down and providers flexible.

---

## 2. Architecture

```
 WhatsApp   ─▶  Tenant OpenWA (their own)  ─▶  POST /webhook/<token>[/<slug>]
                    ▲                                    │
                    │ send-text / typing / history       │ verify token (+HMAC) + dedupe
                    │                                    ▼
                    └────  OpenBridge API (express, :3001) ──▶ OmniRoute (LLM, :20128)
                                 │
                                 ▼
                          Postgres (:5432) — users, characters, wa_sessions,
                                             chat_routing, messages
```

### Directory structure

```
├── docs/ARCHITECTURE.md     # multi-tenancy, webhook scheme, security, Docker topology
├── docs/DATABASE.md         # full schema
├── docs/API.md              # REST + inbound webhook reference
├── Dockerfile               # npm run migrate → node src/server.js
├── docker-compose.yml       # db, api, omniroute
├── db/migrations/001_init.sql
├── src/
│   ├── config.js            # env config (OMNIROUTE_BASE_URL etc.)
│   ├── db.js                # pg Pool
│   ├── migrate.js           # schema_migrations runner + bootstrap admin
│   ├── auth.js              # JWT + X-API-Key middleware
│   ├── server.js            # bootstrap, static SPA, background tenant poller
│   ├── webhook.js           # inbound /webhook/:token[/:slug] (raw body, HMAC, idempotency)
│   ├── routes/              # auth, characters, sessions, settings, webhooks, dashboard
│   └── services/
│       ├── omniroute.js     # chat/completions with fallback
│       ├── openwa.js        # outbound tenant OpenWA client
│       └── bridge.js        # prompt build, routing, typing, inbound handling, session sync
└── public/                  # SPA dashboard
```

---

## 3. Webhook scheme

- `POST /webhook/<webhook_token>` — generic; character resolved by priority below.
- `POST /webhook/<webhook_token>/<character_slug>` — forces that character.
- Token = 48 hex chars, generated at registration, unique, regenerable from dashboard.
- Optional HMAC: `X-OpenWA-Signature: sha256=<hmac>` using tenant `webhook_secret`.
- Idempotency: `X-OpenWA-Idempotency-Key` dedupes within a 5-min window.

### Routing priority

1. webhook `slug`
2. `session.character_id` (per-session assignment)
3. `chat_routing` (per-chat override)
4. `user.default_character_id`
5. first active character

---

## 4. Multi-tenancy model

| Table | Scope | Purpose |
|---|---|---|
| `users` | — | auth, webhook token/secret, OpenWA creds, defaults, typing profile |
| `characters` | user_id | personas (UNIQUE user_id+slug) |
| `wa_sessions` | user_id | tenant OpenWA sessions, status, webhook_registered, assigned character |
| `chat_routing` | user_id | chatId → character override |
| `messages` | user_id | persisted inbound/outbound history |

Tenant OpenWA is **remote**: the bridge holds `openwa_base_url` + `openwa_api_key` per user and
calls it for session discovery, history, typing, send-text, and webhook registration.

---

## 5. Inbound flow

```
webhook → verify token → (HMAC) → (dedupe) → parse event
  → session lookup/upsert → resolve character
  → fetch history from tenant OpenWA → build system prompt
  → askModel (OmniRoute) → typing simulation → sendText (tenant OpenWA)
  → persist incoming + outgoing messages
```

---

## 6. Roadmap

### v2.0 (current)
- [x] Multi-tenant auth (register/login/JWT/API key), bootstrap admin
- [x] Per-user webhook tokens + optional HMAC + idempotency
- [x] PostgreSQL schema + auto-migrations
- [x] Characters CRUD (full persona fields)
- [x] Session discovery + per-session character assignment + auto webhook registration
- [x] Tenant OpenWA outbound client (history, typing, send, webhooks)
- [x] OmniRoute LLM client with fallback
- [x] Persisted message history + dashboard stats/logs
- [x] SPA dashboard (overview, characters, sessions, webhooks, settings)
- [x] Docker compose (db, api, omniroute)
- [x] Docs (ARCHITECTURE, DATABASE, API)

### Future
- [ ] Billing / plans / rate limits per tenant
- [ ] Media messages (images, voice notes)
- [ ] Per-character keyword/command triggers
- [ ] Admin panel for tenant management
- [ ] Webhook retry queue + delivery metrics
