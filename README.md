# OpenBridge — Multi-Tenant WhatsApp AI SaaS

> Multi-tenant bridge that turns WhatsApp numbers into conversational AI characters.
> Each tenant gets its own authenticated webhook, PostgreSQL-backed characters/sessions,
> and plugs its own [OpenWA](https://github.com/rmyndharis/OpenWA) (WhatsApp gateway)
> into [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (LLM gateway) — all in Docker.

**v2.0.0** — rebuilt from the v1 single-user bridge into a PostgreSQL multi-tenant SaaS.

---

## Quick Start

```bash
cp .env.example .env      # generate random secrets (or edit)
docker compose up -d db api
open http://localhost:3001
```

- Login with the bootstrap admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`).
- Register a tenant account (or use the API).
- Add your OpenWA base URL + API key in **Settings**.
- Create characters in **Characters**.
- Copy your webhook URL(s) from **Webhooks** into OpenWA (Session → Webhooks → New).
- Scan the WhatsApp QR at your OpenWA instance, then chat.

---

## How a Message Flows

1. WhatsApp → **OpenWA** → signed webhook `POST /webhook/<webhook_token>[/<character_slug>]`
2. Bridge verifies the token, optional HMAC (`X-OpenWA-Signature`), and dedupes via `X-OpenWA-Idempotency-Key`
3. Resolves the character: webhook slug → session → chat routing → default → first active
4. Pulls recent chat history from the tenant's OpenWA API
5. Calls OmniRoute with the character's system prompt + history
6. Simulates human typing (read → type → delete → think → type → send)
7. Sends the reply via the tenant's OpenWA API and persists both sides to Postgres

---

## Multi-Tenancy

- Every account owns its **webhook token** (48 hex chars) — `POST /webhook/<token>` routes to
  your characters; `POST /webhook/<token>/<slug>` forces a specific character.
- Characters, WhatsApp sessions, chat routing, settings, and messages are all **isolated per user**.
- Tenants run their **own OpenWA**; the bridge only calls out to it. The bridge's Postgres is
  the single source of truth for bridge state.
- Optional per-tenant `webhook_secret` enables HMAC-signed inbound events.
- Inbound/outbound messages are persisted to Postgres for the dashboard.

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create a tenant account (returns JWT + API key + webhook token) |
| `POST` | `/api/auth/login` | Login (JWT) |
| `GET`  | `/api/auth/me` | Current user |
| CRUD   | `/api/characters` | Characters (name, slug, bio, personality, languages, typing profile, …) |
| `GET`  | `/api/sessions` | Discover + list tenant OpenWA sessions |
| `POST` | `/api/sessions/:id/assign` | Assign a character to a session |
| `POST` | `/api/sessions/:id/webhooks` | Register webhooks onto an OpenWA session |
| `GET`  | `/api/sessions/:id/messages` | Persisted conversation per session/chat |
| `GET/PUT` | `/api/settings` | Tenant settings (OpenWA creds, memory, typing) |
| `GET`  | `/api/webhooks` | List webhook URLs + regenerate token |
| `GET`  | `/api/dashboard/*` | Stats, logs, messages |
| `POST` | `/webhook/<token>` | Inbound event (generic routing) |
| `POST` | `/webhook/<token>/<slug>` | Inbound event (forced character) |

Auth: `Authorization: Bearer <jwt>` for all `/api/*` (or `X-API-Key`).

Full reference: `docs/API.md`.

---

## Project Structure

```
├── docs/                     # ARCHITECTURE.md, DATABASE.md, API.md
├── db/migrations/001_init.sql
├── src/
│   ├── server.js             # express bootstrap + session poller
│   ├── webhook.js            # inbound webhook (raw body, HMAC, dedupe)
│   ├── auth.js               # JWT + API-key middleware
│   ├── migrate.js            # schema migrations + bootstrap admin
│   ├── config.js             # env config
│   ├── db.js                 # pg Pool
│   ├── routes/               # auth, characters, sessions, settings, webhooks, dashboard
│   └── services/
│       ├── omniroute.js      # LLM client (chat/completions)
│       ├── openwa.js         # tenant OpenWA client (sessions, history, send, webhooks)
│       └── bridge.js         # prompt build, routing, typing, inbound handling
├── public/                   # SPA dashboard (vanilla JS)
├── Dockerfile                # migrate + boot on start
├── docker-compose.yml        # db, api, omniroute
└── .env.example
```

---

## Docker Topology

| Service | Image | Port | Role |
|---|---|---|---|
| `db` | postgres:16-alpine | 5432 | All bridge state |
| `api` | node:20-alpine (built) | 3001 | API + webhook + dashboard |
| `omniroute` | diegosouzapw/omniroute | 20128 | LLM gateway |

Migrations run automatically on API boot. Bootstrap admin is created from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

---

## Security Notes

- Webhook token doubles as auth for inbound events (48 hex chars, regenerate from dashboard).
- Optional HMAC via tenant `webhook_secret`; idempotency via `X-OpenWA-Idempotency-Key`.
- JWT + API keys for the dashboard/API; passwords hashed with bcrypt.
- `.env` is gitignored — never commit secrets.

---

## Troubleshooting

- **Webhook returns `invalid signature`** — set a matching `webhook_secret` on both sides or leave it unset.
- **Messages never arrive** — the `/webhook/*` path reads the raw body; if another middleware parses JSON first the request hangs. Keep `/api` JSON middleware scoped (already handled in `server.js`).
- **OpenWA returns 409 "Session is not connected"** — scan the QR at your OpenWA instance first.
- **OmniRoute 503** — free providers exhausted; add keys in the OmniRoute dashboard at `http://localhost:20128`.

---

## License

MIT
