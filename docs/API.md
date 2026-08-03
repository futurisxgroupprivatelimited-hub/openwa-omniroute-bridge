# OpenBridge SaaS — REST API

Base URL: `http://localhost:3001` (docker). All `/api/*` routes require:

```
Authorization: Bearer <jwt>
```

(`X-API-Key: <api_key>` is also accepted.) Errors return JSON: `{ "error": "message" }`.

## Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/register` | `{email, password, name?}` | `{token, user}` |
| POST | `/api/auth/login` | `{email, password}` | `{token, user}` |
| GET | `/api/auth/me` | — | `{user}` |

`user` includes: `id, email, name, plan, webhook_token, openwa_base_url, model,
fallback_model, memory_limit, max_tokens, reply_hard_cap, default_character_id,
webhooks_auto_register, typing, api_key`.

## Characters

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/characters` | — | `{characters: [...]}` |
| POST | `/api/characters` | character object | `{character}` (slug auto-generated if omitted) |
| GET | `/api/characters/:id` | — | `{character}` |
| PUT | `/api/characters/:id` | partial fields | `{character}` |
| DELETE | `/api/characters/:id` | — | `{ok:true}` |

Character object:
```json
{
  "name": "Barsha Siwakoti",
  "slug": "barsha",
  "tagline": "Nepali actress & model",
  "greeting": "Hey! K cha? 😊",
  "bio": "...", "personality": "...", "reply_style": "...", "extra_rules": "...",
  "languages": ["English","Nepali"], "tags": ["actress"], "visibility": "private",
  "active": true,
  "example_messages": [{"role":"user","content":"k cha?"},{"role":"assistant","content":"cha ni 😊"}],
  "typing_profile": {"readDelayMs":[2000,5000],"falseStartChance":0.35,"minTypingMs":2000,"maxTypingMs":8000}
}
```

## Sessions (WhatsApp)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/sessions` | — | discovers tenant OpenWA sessions, upserts, returns list |
| GET | `/api/sessions/:id` | — | `{session}` |
| PUT | `/api/sessions/:id` | `{character_id?}` | `{session}` (assign character) |
| DELETE | `/api/sessions/:id` | — | `{ok:true}` |
| GET | `/api/sessions/:id/messages?chatId=&limit=` | — | `{messages:[...]}` |
| PUT | `/api/sessions/:id/webhooks/register` | `{characterIds?}` | `{urls:[...]}` |

## Settings

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/settings` | — | `{settings}` |
| PUT | `/api/settings` | partial fields | `{settings}` |

Fields: `openwa_base_url, openwa_api_key, model, fallback_model, memory_limit, max_tokens,
reply_hard_cap, default_character_id, webhooks_auto_register, typing`.

## Webhooks

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/webhooks` | — | `{base, generic:{path,url}, webhooks:[{characterId,characterName,slug,path,url}]}` |
| POST | `/api/webhooks/regenerate` | — | new `webhook_token`, updates all URLs |

## Dashboard

| Method | Path | Returns |
|---|---|---|
| GET | `/api/dashboard/stats` | totals: messages, characters, sessions, llm_calls |
| GET | `/api/dashboard/logs?lines=N` | recent processed-event log lines |
| GET | `/api/messages?chatId=&limit=` | stored message history |

## Inbound webhook (no auth — uses token)

| Method | Path | Notes |
|---|---|---|
| POST | `/webhook/:webhook_token` | generic routing |
| POST | `/webhook/:webhook_token/:character_slug` | force that character |

Verification: optional HMAC via `X-OpenWA-Signature` (tenant `webhook_secret`), idempotency via
`X-OpenWA-Idempotency-Key`.
