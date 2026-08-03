# OpenWA ⇄ OmniRoute bridge

Connects a WhatsApp number (via OpenWA) to the OmniRoute LLM gateway so incoming
WhatsApp messages are answered by an AI model.

## Flow

```
WhatsApp user
   │  message
   ▼
OpenWA (http://localhost:2785)   — session "krn", receives the message
   │  webhook POST message.received
   ▼
Bridge (this folder, port 3001)
   │  POST /v1/chat/completions  (model auto)
   ▼
OmniRoute (http://localhost:20128)  — routes to a free/available LLM
   │  reply text
   ▼
Bridge
   │  POST /api/sessions/krn/messages/send-text
   ▼
OpenWA  ──▶  WhatsApp user
```

## Run

```bash
./start.sh
```

Config lives in `.env`:
- `OPENWA_API_KEY` — OpenWA admin/operator key
- `OMNIROUTE_BASE_URL` / `OMNIROUTE_MODEL` — LLM gateway (`auto` = smart routing)
- `WEBHOOK_SECRET` — must match the secret registered on the OpenWA webhook
- `SYSTEM_PROMPT` — persona of the WhatsApp assistant

## Register the webhook (already done)

```bash
# sessionId here is the session UUID (from GET /api/sessions), NOT the name.
# Current session: 50031d5c-7f1f-406a-b5fa-532e6e4d7d32 (name "krn")
curl -X POST http://localhost:2785/api/sessions/50031d5c-7f1f-406a-b5fa-532e6e4d7d32/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $OPENWA_API_KEY" \
  -d '{
    "url": "http://localhost:3001/webhook",
    "events": ["message.received"],
    "secret": "'"$WEBHOOK_SECRET"'"
  }'
```

## Test

1. Open http://localhost:2785 → session `krn` → confirm the QR is linked.
2. Send a WhatsApp message to the connected number.
3. Bridge replies via OmniRoute:
   - `curl http://localhost:3001/health`
   - `docker logs openwa-api` / bridge stdout for `[msg]` / `[llm]` lines
