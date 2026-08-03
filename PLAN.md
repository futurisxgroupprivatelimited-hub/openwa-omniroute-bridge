# OpenWA Bridge — Multi-Character WhatsApp LLM Assistant

A professional, self-contained WhatsApp bridge that connects **OpenWA** (WhatsApp gateway)
to **OmniRoute** (multi-provider LLM gateway) with **editable multi-character personas**,
**hyper-realistic human typing simulation**, and a **full management dashboard**.

---

## 1. Vision

Turn any WhatsApp number into a conversational AI character that:
- Replies as a **specific persona** (e.g. a Nepali actress, a business, a friend)
- Maintains **per-chat memory** from the OpenWA database
- Types like a **real human** (read → type → delete → think → type → send)
- Keeps **short, natural** replies with emojis
- Supports **multiple characters** on the same number, routed per chat
- Is fully **editable from a dashboard** — no code changes needed

---

## 2. Architecture

```
┌──────────────┐     ┌─────────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   WhatsApp   │────▶│      OpenWA Server      │────▶│   Bridge (Node.js)  │────▶│    OmniRoute    │
│    User      │◀────│   port 2785 (Docker)    │◀────│     port 3001       │◀────│   port 20128    │
│              │     │                         │     │                     │     │                 │
│ Sends msg    │     │ • whatsapp-web.js engine│     │ • HMAC verify       │     │ • 290+ providers│
│ Sees typing  │     │ • Webhook dispatch      │     │ • Memory fetch (DB) │     │ • Free tier      │
│ Gets reply   │     │ • Typing indicator      │     │ • Character routing │     │ • Auto-fallback │
└──────────────┘     │ • REST API + Dashboard  │     │ • LLM call          │     └─────────────────┘
                     │ • SQLite storage        │     │ • Typing simulation │
                     └─────────────────────────┘     │ • Send reply        │
                                                      └─────────────────────┘
```

### Directory structure

```
openwa-omniroute-bridge/
├── bridge.mjs              # Main server (zero deps, Node built-ins only)
├── characters.json         # ★ EDITABLE character profiles (multi-persona)
├── settings.json           # ★ EDITABLE bridge settings (model, memory, typing)
├── .env                    # Secrets (API keys, webhook secret) — gitignored
├── start.sh                # Launcher (loads .env, starts bridge)
├── package.json            # Metadata + scripts
├── PLAN.md                 # This document
├── .gitignore
└── public/
    └── index.html          # Management dashboard (status, editors, logs)
```

---

## 3. Data flow — one incoming message

```
User types "k cha?"
  1. OpenWA engine receives the message
  2. OpenWA fires `message.received` → POSTs signed webhook to bridge
  3. Bridge verifies HMAC-SHA256 signature
  4. Bridge deduplicates via X-OpenWA-Idempotency-Key
  5. Bridge fetches last N messages from OpenWA DB (per-chat memory)
  6. Bridge picks the character routed to this chat (or default)
  7. Bridge assembles: system prompt (character) + history + user message
  8. Bridge calls OmniRoute /v1/chat/completions (model from settings)
  9. Bridge executes the typing pattern (8–15s of realism)
 10. Bridge sends reply via OpenWA send-text API
 11. WhatsApp delivers reply to the user
```

---

## 4. Multi-character system

### characters.json — one record per persona

```json
{
  "characters": [
    {
      "id": "barsha",
      "name": "Barsha Siwakoti",
      "active": true,
      "default": true,
      "languages": ["English", "Nepali"],
      "replyStyle": "short, casual, max 1-2 sentences, emojis sparingly",
      "personality": "warm, friendly, playful, never reveals being AI",
      "bio": "Born 6 April 1993 in Kawasoti Nepal...",
      "typingProfile": {
        "readDelayMs": [2000, 5000],
        "falseStartChance": 0.35,
        "minTypingMs": 2000,
        "maxTypingMs": 8000
      }
    }
  ],
  "chatRouting": {
    "104089270661245@lid": "barsha"
  }
}
```

### Routing rules

1. If a `sessionId` is in `sessionRouting`, use that character (per-WhatsApp-number).
2. If a `chatId` is in `chatRouting`, use that character.
3. Otherwise use the character flagged `"default": true`.
4. Characters can be toggled `active` — inactive ones are never assigned.

### Multi-session awareness

The bridge discovers all OpenWA sessions (`GET /api/sessions`) on startup and polls every 30s.
For each session it tracks: name, status (ready/qr_ready/etc.), phone, webhook registration,
last seen activity, and the character it routes to. Newly discovered sessions get their webhook
auto-registered. Exposed via `GET /sessions` and surfaced in the dashboard **Sessions** tab.

---

## 5. Typing simulation (hyper-realistic)

```
Step 1   READ message            2–5s        (human reads before reacting)
Step 2   START typing            1.5–3.5s    (types something)
Step 3   DELETE everything       1.5–4s      (changes mind, thinks)
Step 4   FALSE START (35%)       1–2.5s      (types again, deletes again)
Step 5   FINAL typing            2–8s        (scales with reply length)
Step 6   RE-READ before send     0.4–1.2s    (re-reads, hits send)
Step 7   MESSAGE DELIVERED        ✓
```

Each step toggles OpenWA's typing indicator (`sendChatState: typing/paused`), so the
recipient sees the "typing..." bubble appear, vanish, and reappear realistically.
All timings are per-character editable in `characters.json` → `typingProfile`.

---

## 6. Configurability

| What | Where | Editable in dashboard |
|---|---|---|
| Model (e.g. antigravity/gpt-oss-120b-medium) | `settings.json` | ✅ |
| Memory depth (messages fetched per chat) | `settings.json` | ✅ |
| Max LLM tokens / reply cap | `settings.json` | ✅ |
| Typing timings (global) | `settings.json` | ✅ |
| Characters (name, bio, prompt, languages) | `characters.json` | ✅ |
| Chat → character routing | `characters.json` | ✅ |
| Secrets (API key, webhook secret) | `.env` | ❌ (by design) |

---

## 7. API surface (bridge, port 3001)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook` | OpenWA webhook receiver (HMAC verified) |
| GET  | `/health` | Liveness + stats + session count |
| GET  | `/logs?lines=N` | Recent bridge logs |
| GET  | `/config` | Resolved config (settings + active prompt + sessions) |
| GET  | `/sessions` | Discovered OpenWA sessions (status, webhook, character) |
| PUT  | `/sessions` | Save session → character routing |
| GET  | `/characters` | All character profiles |
| PUT  | `/characters` | Save all characters (persists to disk) |
| GET  | `/settings` | Current settings |
| PUT  | `/settings` | Save settings (persists to disk) |

---

## 8. Roadmap

### v0.3 (current)
- [x] Webhook receiver with HMAC + idempotency
- [x] Per-chat memory from OpenWA DB
- [x] Single-character persona (Barsha Siwakoti)
- [x] Hyper-realistic typing simulation
- [x] Multi-character routing (`chatRouting` + default)
- [x] Multi-session awareness (discover + auto-register webhooks + per-session routing)
- [x] Dashboard editors for characters + settings + session routing
- [x] One-command setup (`setup.sh`) — installs OpenWA + OmniRoute
- [x] Professional character model (greeting, tags, visibility, examples, version)
- [x] Full README docs
- [ ] Send media (images, voice) — future
- [ ] Keyword/command triggers per character — future
- [ ] Rate limiting / cooldowns per chat — future
- [ ] `antigravity/gpt-oss-120b-medium` via OmniRoute Google OAuth — blocked on user auth
