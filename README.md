# OpenWA Bridge — Multi-Character WhatsApp AI Platform

> Professional, self-contained WhatsApp bridge that turns any number into conversational AI characters.
> Connects [OpenWA](https://github.com/rmyndharis/OpenWA) (WhatsApp gateway) to [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (LLM gateway) with editable personas, hyper-realistic typing, and a full management dashboard.

---

## Quick Start (one command)

```bash
# Clone and run everything
git clone https://github.com/futurisxgroupprivatelimited-hub/openwa-omniroute-bridge.git
cd openwa-omniroute-bridge
chmod +x setup.sh
./setup.sh
```

The setup script automatically:
- ✅ Checks prerequisites (Docker, Node.js, git)
- ✅ Clones OpenWA and starts it via Docker
- ✅ Starts OmniRoute via Docker
- ✅ Configures the bridge with secrets
- ✅ Registers the webhook on OpenWA
- ✅ Starts the bridge on port 3001

After setup, open the dashboard at **http://localhost:3001** and scan the QR at **http://localhost:2785**.

---

## What It Does

1. Someone sends a WhatsApp message to your linked number
2. OpenWA receives it and fires a signed webhook to the bridge
3. The bridge looks up which **character** handles that chat
4. It loads the last N messages as **conversation memory** from OpenWA's database
5. It calls OmniRoute (multi-provider LLM) with the character's system prompt + history
6. It simulates **hyper-realistic typing** (type → delete → think → type → send)
7. It sends the reply back through OpenWA to WhatsApp

---

## Features

### Multi-Character System
- Define unlimited characters with unique personalities, bios, and reply styles
- Assign different characters to different chats
- Toggle characters active/inactive
- Set a default character for new conversations

### Multi-Session Support
- Discover all WhatsApp numbers linked in OpenWA automatically
- Dashboard **Sessions** tab shows every session: status, phone, webhook, last activity
- Assign a **different character to each session** (e.g. one number acts as Barsha, another as a business bot)
- Webhooks are **auto-registered** when a new session is discovered — zero manual config
- Per-chat routing still works within each session

### Per-Character Webhooks
- Every active character gets a **unique webhook URL** (`/webhook/barsha`, `/webhook/business-bot`, …)
- Add a character's URL in OpenWA and all messages arriving through it are handled by **that character** — no chat or session routing needed
- Dashboard **Webhooks** tab: copy any character URL, or register it onto a session with one click
- Webhook base configurable via `OPENWA_WEBHOOK_BASE` (default `http://host.docker.internal:3001` for Docker OpenWA)

### Hyper-Realistic Typing
- 7-step typing pattern based on real human behavior research
- Type → delete everything → pause to think → maybe false start → type again → re-read → send
- Configurable timing per character
- Recipient sees realistic "typing..." bubbles

### Per-Chat Memory
- Fetches last 40 messages from OpenWA's SQLite database
- Chronological conversation history sent to the LLM
- Bot remembers what was discussed earlier in each chat

### Management Dashboard
- **Overview**: Live status of all services, message counts, recent messages, live logs
- **Characters**: Add/edit/delete personas with full bio, personality, reply style, languages
- **Settings**: Model, fallback model, memory depth, token limits, typing timings
- **Messages**: View conversation history per chat
- **Logs**: Color-coded bridge logs with auto-scroll
- **Typing**: Visual flow diagram of the typing simulation
- **Architecture**: System diagram

### Model Flexibility
- Use any OpenAI-compatible model via OmniRoute
- Default: `big-pickle` (free tier, works immediately)
- Supports: `antigravity/gpt-oss-120b-medium` (needs Google OAuth in OmniRoute dashboard)
- Automatic fallback if primary model fails

---

## Project Structure

```
openwa-omniroute-bridge/
├── bridge.mjs              # Main server (zero external deps)
├── characters.json         # ★ EDITABLE — character profiles
├── settings.json           # ★ EDITABLE — bridge settings
├── .env                    # Secrets (gitignored)
├── setup.sh                # One-command setup (installs OpenWA + OmniRoute)
├── start.sh                # Bridge launcher
├── PLAN.md                 # Architecture and roadmap
├── README.md               # This file
├── package.json            # Metadata
├── .gitignore
└── public/
    └── index.html          # Management dashboard
```

---

## Character Configuration

Edit `characters.json` to define your characters. Each character has:

```json
{
  "id": "barsha",
  "name": "Barsha Siwakoti",
  "active": true,
  "default": true,
  "languages": ["English", "Nepali"],
  "personality": "warm, friendly, playful, never reveals being AI",
  "replyStyle": "very short, 1-2 sentences, casual WhatsApp style",
  "bio": "Full biography here...",
  "extraRules": "Additional behavioral rules...",
  "typingProfile": {
    "readDelayMs": [2000, 5000],
    "falseStartChance": 0.35,
    "minTypingMs": 2000,
    "maxTypingMs": 8000
  }
}
```

### Chat Routing

Assign characters to specific chats in the `chatRouting` map:

```json
{
  "chatRouting": {
    "104089270661245@lid": "barsha",
    "217763482206244@lid": "business-bot"
  }
}
```

Chats without an explicit assignment use the character marked `"default": true`.

### Session Routing

Assign characters to entire sessions (one WhatsApp number per session) in the `sessionRouting` map.
Sessions are discovered automatically from OpenWA — edit routing from the dashboard **Sessions** tab:

```json
{
  "sessionRouting": {
    "7f5935cb-7922-49ad-ba17-8f84e9034f81": "barsha"
  }
}
```

Priority: **webhook character** → **session routing** → **chat routing** → **default character**.

### Per-Character Webhooks

Each active character exposes a webhook URL, derived from its id (or an optional `webhookPath` field):

| Character | Webhook URL |
|---|---|
| Barsha Siwakoti | `http://host.docker.internal:3001/webhook/barsha` |
| Business Bot | `http://host.docker.internal:3001/webhook/business-bot` |

Register a character webhook in OpenWA (Session → Webhooks → New) using the **same secret** as `.env → WEBHOOK_SECRET`.
Messages delivered via that URL are answered exclusively by that character. The bridge auto-registers
the generic webhook + every character webhook on newly discovered sessions (disable via
`settings.json → webhooks.autoRegister`).

---

## Settings

Edit `settings.json` to configure the bridge:

| Setting | Default | Description |
|---|---|---|
| `model` | `big-pickle` | Primary LLM model (OmniRoute model name) |
| `fallbackModel` | `auto` | Fallback model if primary fails |
| `memoryLimit` | `40` | Messages fetched per chat for context |
| `maxTokens` | `80` | Max LLM response tokens |
| `replyHardCap` | `120` | Hard character limit on replies |
| `defaultCharacter` | `barsha` | Default character ID |

---

## API Reference

The bridge exposes these endpoints on port 3001:

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook` | Generic webhook receiver (session → chat → default routing) |
| `POST` | `/webhook/:slug` | Per-character webhook receiver (forces that character) |
| `GET` | `/webhooks` | List generic + per-character webhook URLs |
| `POST` | `/webhooks/register` | Register webhook(s) onto an OpenWA session |
| `GET` | `/health` | Liveness check + stats + session count |
| `GET` | `/logs?lines=N` | Recent bridge logs |
| `GET` | `/config` | Resolved config + active prompt + sessions |
| `GET` | `/sessions` | Discovered OpenWA sessions (status, webhook, character) |
| `PUT` | `/sessions` | Save session → character routing |
| `GET` | `/characters` | All character profiles |
| `PUT` | `/characters` | Save all characters (persists to disk) |
| `GET` | `/settings` | Current settings |
| `PUT` | `/settings` | Save settings (persists to disk) |

---

## Architecture

```
┌──────────────┐     ┌─────────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   WhatsApp   │────▶│      OpenWA Server      │────▶│   Bridge (Node.js)  │────▶│    OmniRoute    │
│    User      │◀────│   port 2785 (Docker)    │◀────│     port 3001       │◀────│   port 20128    │
└──────────────┘     └─────────────────────────┘     └─────────────────────┘     └─────────────────┘
                            │ SQLite DB                    │ characters.json
                            │ Messages table               │ settings.json
                            │ Webhooks table               │ .env (secrets)
```

### Data Flow

```
WhatsApp → OpenWA (engine) → Webhook POST (HMAC signed) → Bridge
  → Verify signature → Deduplicate → Resolve character:
      webhook slug (e.g. /webhook/barsha) → sessionRouting → chatRouting → default
  → Fetch memory from OpenWA DB
  → Look up character for this chat → Build system prompt
  → Call OmniRoute /v1/chat/completions → Get reply
  → Execute typing simulation (8-15s) → Send reply via OpenWA
  → WhatsApp delivers to user
```

---

## Typing Simulation

The bridge simulates realistic human typing in 7 steps:

1. **Read message** (2–5s) — human reads before reacting
2. **Start typing** (1.5–3.5s) — types something
3. **DELETE everything** (1.5–4s) — changes mind, thinks
4. **False start** (35% chance) — types again then deletes again
5. **Final typing** (2–8s) — actually writes the reply (scales with length)
6. **Re-read before send** (0.4–1.2s) — re-reads, hits send
7. **Message delivered** ✓

All timings are configurable per character in `characters.json → typingProfile`.

---

## Troubleshooting

### WhatsApp session keeps disconnecting
WhatsApp's anti-automation detection may unlink the device. Solutions:
- Use a **dedicated number** (not your personal phone)
- Avoid bulk/rapid messages
- The typing simulation helps (delays look more human)
- Re-scan QR at http://localhost:2785

### Webhook returns 409 "Session is not connected"
The WhatsApp session is `qr_ready` (not linked). Scan the QR at http://localhost:2785.

### OmniRoute returns 503 "Maximum combo retry limit reached"
All free-tier providers are exhausted. Wait for quotas to reset, or add your own API keys in the OmniRoute dashboard at http://localhost:20128.

### System prompt shows "Loading..." in dashboard
Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).

---

## Tech Stack

| Component | Technology | Port |
|---|---|---|
| WhatsApp Gateway | OpenWA (whatsapp-web.js) | 2785 |
| LLM Gateway | OmniRoute (290+ providers) | 20128 |
| Bridge | Node.js (zero deps) | 3001 |
| Database | SQLite (OpenWA's) | — |
| Container | Docker | — |

---

## License

MIT
