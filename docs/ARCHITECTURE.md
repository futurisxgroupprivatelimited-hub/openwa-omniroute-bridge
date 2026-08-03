# OpenBridge SaaS — Architecture

A **multi-tenant** WhatsApp AI platform. Every tenant gets a unique, authenticated webhook URL
they paste into their own OpenWA dashboard. Tenants manage unlimited characters and link each
of their WhatsApp sessions to a specific character. All data lives in **PostgreSQL**. Everything
runs inside **Docker**.

---

## 1. Multi-Tenancy Model

```
                          ┌─────────────────────────────────────────────┐
                          │           OpenBridge SaaS (Docker)          │
                          │                                             │
┌──────────────┐          │  ┌───────────────────────────────────────┐  │
│  Tenant A    │   HTTPS   │  │           API + Webhook (Node.js)     │  │
│  OpenWA      │──────────▶│  │  POST /webhook/<token>[ /<slug>]      │  │
│  (self-host) │  webhook  │  │  GET/PUT /api/*  (JWT authenticated)  │  │
└──────────────┘          │  │            │          │               │  │
                          │  └────────────┼──────────┼───────────────┘  │
┌──────────────┐          │               ▼          ▼                 │
│  Tenant B    │   HTTPS   │  ┌───────────────────────────────┐  ┌──────┴─────┐
│  OpenWA      │──────────▶│  │      PostgreSQL 16            │  │  OmniRoute │
└──────────────┘  webhook  │  │  users / characters /         │  │  (LLM)     │
                          │  │  wa_sessions / messages /      │  │  20128     │
┌──────────────┐          │  │  chat_routing                  │  └────────────┘
│  Browser     │   HTTPS   │  └───────────────────────────────┘
│  Dashboard   │──────────▶│  POST /api/auth/login → JWT
└──────────────┘          └─────────────────────────────────────────────┘
```

### Key principles

1. **One shared instance, zero shared data.** The SaaS runs a single API + webhook process and a
   single PostgreSQL. Tenancy is enforced by `user_id` foreign keys on every row and a mandatory
   `WHERE user_id = $userId` on every query.
2. **Webhook token = tenant identity.** Each user is issued a cryptographically random
   `webhook_token` (48 hex chars). Their webhook URL is `https://host/webhook/<token>`.
   The token *is* the authentication for inbound WhatsApp events — nobody can guess it, so nobody
   can spoof a tenant's webhook. OpenWA can additionally HMAC-sign each delivery; the bridge
   verifies it against the tenant's `webhook_secret`.
3. **Tenant OpenWA is remote.** The SaaS does not host WhatsApp sessions. Each tenant runs their
   own OpenWA (any number/link they own) and registers their OpenWA Base URL + API key in the
   dashboard. The SaaS calls *out* to that tenant's OpenWA to fetch history, toggle typing and
   send replies. This is what makes the SaaS itself WhatsApp-free and safe to operate.
4. **Per-character webhooks.** A tenant can also use `https://host/webhook/<token>/<slug>` so a
   specific OpenWA webhook is always answered by one specific character.
5. **Sessions → characters.** The dashboard discovers the tenant's OpenWA sessions and lets them
   attach a character to each. Webhook slug > session assignment > chat routing > default character.

---

## 2. Webhook URL Scheme (with auth code at the end)

| Purpose | URL | Auth |
|---|---|---|
| Generic (routing) | `POST https://host/webhook/<webhook_token>` | token + optional HMAC |
| Per-character | `POST https://host/webhook/<webhook_token>/<character_slug>` | token + optional HMAC |

* The `<webhook_token>` is unique per user, generated at registration, stored hashed-safe (token
  itself is unguessable random; it is stored as-is so OpenWA can hit it).
* Character slugs are unique per user (`UNIQUE (user_id, slug)`).
* HMAC verification (optional): OpenWA signs the body with a secret the tenant sets on their
  webhook; the bridge verifies using the tenant's `webhook_secret` (sha256 HMAC, `X-OpenWA-Signature`).
* Idempotency: `X-OpenWA-Idempotency-Key` header, deduplicated for 5 minutes.

### Inbound flow (one message)

```
OpenWA (tenant) fires message.received
  → POST /webhook/<token>[ /<slug>] with HMAC header
  → bridge resolves tenant by webhook_token
  → verify HMAC (if tenant.webhook_secret set)
  → dedupe by idempotency key
  → find wa_session by (user_id, event.sessionId)
  → resolve character: slug → session.character_id → chat_routing → default
  → fetch history from tenant's OpenWA (GET .../messages?chatId&limit=memoryLimit)
  → call OmniRoute /v1/chat/completions (tenant settings.model, fallback)
  → run typing simulation against tenant's OpenWA
  → send reply via tenant's OpenWA
  → persist incoming + outgoing rows in messages table
```

---

## 3. Authentication (Dashboard API)

- `POST /api/auth/register` → creates user, returns JWT.
- `POST /api/auth/login` → verifies bcrypt hash, returns JWT (`{ sub: userId, email }`).
- `Authorization: Bearer <jwt>` on every `/api/*` route.
- `X-API-Key: <api_key>` also accepted (for programmatic use / OpenWA webhook registration).
- JWT secret, expiry configurable via env. bcrypt cost 10.
- Admin user bootstrapped from env (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) on first migration for the
  platform operator.

---

## 4. Multi-Character System

Tenants create unlimited characters. Full field set (from character.ai research):

| Field | Type | Purpose |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | Display name |
| `slug` | text | URL-safe id used in `/webhook/<token>/<slug>` |
| `tagline` | text | One-line descriptor |
| `greeting` | text | Opening message for a new chat |
| `bio` | text | Life story / knowledge fed to the model |
| `personality` | text | Traits — how it behaves |
| `reply_style` | text | Formatting / length rules |
| `extra_rules` | text | Hard constraints (never reveal AI, language rules) |
| `languages` | text[] | Allowed languages |
| `tags` | text[] | Search/discovery |
| `visibility` | public/private/unlisted | Discovery flag |
| `active` | bool | On/off (inactive never assigned) |
| `example_messages` | jsonb | Few-shot example dialogues |
| `typing_profile` | jsonb | Per-character typing timings |

System prompt is assembled server-side from these fields (same prompt builder as the single-user
bridge, now per-character rows).

---

## 5. Sessions → Characters

`wa_sessions` stores one row per (user, OpenWA session). The dashboard:

1. Calls `GET /api/sessions` — the API queries the tenant's OpenWA
   (`GET {base}/api/sessions` with their API key) and upserts rows.
2. Polls every 30s in the background per active tenant to keep `status`/`phone`/`last_seen`
   fresh and to auto-register webhooks (`webhooks_auto_register`).
3. `PUT /api/sessions/:id` with `character_id` assigns a character. The bridge resolves
   session → character this way, so each WhatsApp session replies as its assigned character.

Routing priority (highest → lowest): **webhook slug → session.character_id → chat_routing → user.default_character_id**.

---

## 6. Message Pipeline (services/bridge.js)

Port of the proven single-user pipeline, now user-scoped and DB-backed:

```
resolveTenantByToken()
resolveCharacter(event, session, user, slug)
fetchChatHistory(user, session, chatId, exclude)     → tenant OpenWA + memoryLimit
buildSystemPrompt(character)
askOmniRoute(user, messages)                         → OmniRoute, model/fallback from user
humanTypingPattern(user, session, chatId, len)       → typing simulation
sendWhatsApp(user, session, chatId, text)            → tenant OpenWA
persistMessage(user, session, chat, direction, body)
```

---

## 7. Docker Topology

`docker-compose.yml` (single command: `docker compose up`):

| Service | Image | Port | Role |
|---|---|---|---|
| `db` | postgres:16-alpine | 5432 | PostgreSQL (volume `pgdata`) |
| `api` | local Dockerfile (node:20-alpine) | 3001 | Express API + webhook + dashboard SPA |
| `omniroute` | diegosouzapw/omniroute:latest | 20128 | LLM gateway (shared) |
| `openwa` | *(optional, commented)* | 2785 | Demo tenant gateway |

The `api` container runs migrations on boot (`npm run migrate`), then serves. Healthchecks on
`db` gate startup ordering.

---

## 8. Directory Structure

```
openwa-omniroute-bridge/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── db/
│   └── migrations/001_init.sql
├── src/
│   ├── server.js            # express bootstrap + static dashboard
│   ├── config.js            # env parsing
│   ├── db.js                # pg Pool
│   ├── migrate.js           # migration runner
│   ├── auth.js              # JWT/API-key middleware
│   ├── webhook.js           # POST /webhook/:token[/:slug]
│   ├── routes/
│   │   ├── auth.js          # register / login / me
│   │   ├── characters.js
│   │   ├── sessions.js
│   │   ├── settings.js
│   │   ├── webhooks.js      # list/register webhook URLs
│   │   └── dashboard.js     # stats + logs + messages
│   └── services/
│       ├── bridge.js        # message pipeline (tenant-scoped)
│       └── omniroute.js     # LLM client
└── public/
    ├── index.html           # SPA (login/register + tenant dashboard)
    ├── styles.css
    └── app.js
```

---

## 9. Security

- Webhook token: 48 random hex chars — acts as bearer credential for inbound events.
- HMAC verification when `webhook_secret` is set.
- Passwords: bcrypt (cost 10), never logged.
- JWT: signed with server secret, exp 12h default.
- Tenant scoping: every SQL query filters `user_id = $userId`; DB enforces FKs with CASCADE.
- `.env` holds secrets; `.env.example` committed, `.env` gitignored.
- Webhook body size capped 2MB; request timeouts everywhere.

## 10. Roadmap

- [x] Multi-tenant auth (register/login/JWT)
- [x] PostgreSQL persistence for all tenants
- [x] Unique authenticated webhook URLs per user
- [x] Per-character webhook slugs
- [x] Sessions ↔ character assignment
- [x] Full docker compose with Postgres
- [ ] Tenant billing/plans gating (free/pro tiers)
- [ ] Usage metering + rate limits per tenant
- [ ] Web dashboard multi-tenant OpenWA provisioning
