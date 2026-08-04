# OpenBridge — Test Suite & Case Documentation

All tests use Node's built-in test runner (`node:test`) and the `assert/strict` API.
Run everything with:

```bash
npm test              # unit + integration (integration skips itself if Postgres is down)
node --test test/stats.test.js   # a single file
```

## Layout

| File | Scope | Needs DB / network |
|---|---|---|
| `test/stats.test.js` | stats helpers (pure) | no |
| `test/scraper.test.js` | scraper + sanitizers (network mocked) | no |
| `test/bridge.test.js` | prompt builder / URL helpers (pure) | no |
| `test/omniroute.test.js` | LLM client + reply trimming (fetch mocked) | no |
| `test/gateway.test.js` | secret masking (pure) | no |
| `test/auth.test.js` | JWT + payload + middleware (pure) | no |
| `test/characters.test.js` | character field helpers (pure) | no |
| `test/admin.test.js` | page-number clamp helper (pure) | no |
| `test/db-integration.test.js` | notifications, stats countQuery, characters jsonb (live Postgres) | yes |

**Integration tests** build their connection string from `.env` (`POSTGRES_*`),
fall back to `DATABASE_URL`, and rewrite the compose hostname `db` → `localhost`.
If Postgres is unreachable every test in the file self-skips.

---

## `src/services/stats.js`

### `rangeToDates(range, from, to)`
| # | Case | Input | Expected |
|---|---|---|---|
| 1 | named range 7d | `('7d', null, <t>)` | start = t − 7d, end = t |
| 2 | named range 30d | `('30d', null, <t>)` | start = t − 30d |
| 3 | `'all'` → epoch | `('all'\|undefined\|null, …)` | start = `new Date(0)` |
| 4 | explicit from/to wins | `('7d', <from>, <to>)` | start = from, end = to |
| 5 | unknown range name | `('bogus', null, <t>)` | start == end (0 days) |
| 6 | no `to` uses now | `('30d')` | end ≈ `Date.now()`, start = end − 30d |

### `buildMessageWhere(filters)`
| # | Case | Input | Expected |
|---|---|---|---|
| 7 | always range-bounded | `{ range:'30d' }` | 2 clauses + 2 `Date` params |
| 8 | sequential placeholders | all 5 filters | params order userId, sessionId, characterId, direction, chatId; `$1`…`$7` present |
| 9 | blank filters ignored | empty/undefined/null | only the 2 range params |
| 10 | `'all'` epoch param | `{ range:'all' }` | `params[0]` = epoch |

### `pageMeta(total, page, perPage)`
| # | Case | Input | Expected |
|---|---|---|---|
| 11 | exact division | `(100,1,25)` | `pages: 4` |
| 12 | zero total | `(0,1,25)` | `pages: 1` (never 0) |
| 13 | small totals | `(24,2,25)`, `(26,…)`, `(25,…)`, `(1,1,100)` | ceil logic + min 1 |

### `splitNums(s)`
| # | Case | Input | Expected |
|---|---|---|---|
| 14 | comma list | `'a,b, c ,,d'` | `['a','b','c','d']` |
| 15 | empty / nullish | `''`, `undefined`, `null` | `[]` |
| 16 | single value | `'only'` | `['only']` |

---

## `src/services/scraper.js`

### `isValidUrl(u)`
| # | Case | Input | Expected |
|---|---|---|---|
| 17 | http/https ok | `https://example.com/a?b=1`, `http://example.com` | `true` |
| 18 | bad schemes / junk | ftp, plain text, `javascript:`, `file:`, `''`, `undefined` | `false` |

### `decodeEntities(s)`
| # | Case | Input | Expected |
|---|---|---|---|
| 19 | common entities | `&amp; &lt; &quot; &#39; &apos; &nbsp;` | decoded |
| 20 | numeric refs | `&#65;&#66;` | `'AB'` |

### `stripHtml(html)`
| # | Case | Input | Expected |
|---|---|---|---|
| 21 | strips tags + blocks | `<p>Hello</p><script>…</script><style>…</style><noscript>…</noscript>` | text only, no script/style/tag markup |

### `cleanText(text)`
| # | Case | Input | Expected |
|---|---|---|---|
| 22 | whitespace + line collapse | `'  a \t\t b  \n\n  \n c '` | `'a b\nc'` |
| 23 | control chars removed | `'a\0b\x1f\x7fc'` | no control chars |
| 24 | MAX_CHARS cap | 60000 × `'x'` | length ≤ 40000 |

### `pageTitle(html)`
| # | Case | Input | Expected |
|---|---|---|---|
| 25 | title extracted | `<title> My Page </title>` | `'My Page'` |
| 26 | entity decoding | `<title>A &amp; B</title>` | `'A & B'` |
| 27 | no title | `<html></html>`, `''` | `''` |

### `extractMeta(html)`
| # | Case | Input | Expected |
|---|---|---|---|
| 28 | og:/description/twitter metas | sample metas | contains all three, excludes `og:image` |
| 29 | no metas | `<html></html>` | `''` |

### `scrapeUrl(url)` / `scrapeMany(links)` (fetch mocked)
| # | Case | Setup | Expected |
|---|---|---|---|
| 30 | jina reader path | reader returns markdown | `status:'ok'`, wordCount > 0 |
| 31 | reader fails → direct fallback | reader 500, direct returns HTML | `status:'ok'`, body includes `<title>` text |
| 32 | both fail | reader + direct 4xx | `status:'error'`, non-empty `error` |
| 33 | invalid URL, no network | `'not-a-url'` | `status:'error'`, message matches `/valid/i` |
| 34 | scrapeMany caps at 8 | 9 links | exactly 8 results, each `ok` with `excerpt` |
| 35 | scrapeMany skips blanks | `[]`, `['','  ',null]` | `[]` |

---

## `src/services/bridge.js`

### `isOnline(status)`
| # | Case | Input | Expected |
|---|---|---|---|
| 36 | online statuses (case-insensitive) | `ready`/`READY`/`active`/`connected` | `true` |
| 37 | offline / missing | `disconnected`, `unknown`, `''`, `undefined`, `null` | `false` |

### `driveDirectUrl(link)`
| # | Case | Input | Expected |
|---|---|---|---|
| 38 | `/file/d/<id>` → direct download | share link | `https://drive.google.com/uc?export=download&id=<id>` |
| 39 | `/open?id=<id>` → direct download | open link | same direct form |
| 40 | non-drive passthrough (trimmed) | `https://example.com/pic.jpg` | unchanged |
| 41 | empty input | `''`, `undefined`, `null` | `''` |

### `splitMediaTokens(reply)`
| # | Case | Input | Expected |
|---|---|---|---|
| 42 | extracts + strips one token | `'caption\n[IMG:u]'` | media `['u']`, text without token |
| 43 | multiple tokens | `'[IMG:a]\nb\n[IMG:b]'` | media `['a','b']` |
| 44 | no tokens | `'plain reply'` | media `[]`, text unchanged |
| 45 | collapses 3+ newlines | `'a\n\n\n\n\nb'` | `'a\n\nb'` |
| 46 | empty reply | `''` | text `''`, media `[]` |

### `buildSystemPrompt(character)`
| # | Case | Input | Expected |
|---|---|---|---|
| 47 | no character → default | `null`/`undefined` | friendly default string |
| 48 | identity + anti-AI rule | `{ name:'Rita' }` | includes `You are Rita`, `Never reveal that you are an AI` |
| 49 | optional sections | full character | BIO, LANGUAGES, PERSONALITY, REPLY STYLE, EXTRA RULES, VERIFIED KNOWLEDGE, SOCIAL LINKS, `[IMG:…]`, EXAMPLE CONVERSATION all present |
| 50 | malformed social links | link with url but no label/type | no literal `undefined` in output |
| 51 | multi-language + example role mapping | languages `['EN','HI']`, assistant example | `Only reply in EN or HI`, `X: hi` |

### `webhookUrl(user, character)`
| # | Case | Input | Expected |
|---|---|---|---|
| 52 | per-character webhook | `{webhook_token:'tok'}` + `{slug:'rita'}` | ends `/webhook/tok/rita` |
| 53 | generic fallback | `{webhook_token:'tok'}` + `null` | ends `/webhook/tok` |

### `typingSchedule(typing, replyLength)`
| # | Case | Input | Expected |
|---|---|---|---|
| 106 | disabled returns nothing | `{enabled:false}` | `[]` |
| 107 | enabled produces Reading/Thinking/Typing | `falseStartChance:0` | exactly 3 phases in that order |
| 108 | read delay within bounds | `readDelayMs:[1000,2000]` × 50 runs | every read `∈[1000,2000]` |
| 109 | typing time clamped | `min:500,max:700` × 50 runs | typing `∈[500,700]` |
| 110 | false-start phase possible | `falseStartChance:1` | `Starting to type` appears |
| 111 | defaults when typing undefined | `undefined` | ≥3 phases, starts `Reading`, ends `Typing` |

### `buildCharacterMessages(character, history, text)` — shared playground + webhook pipeline
| # | Case | Input | Expected |
|---|---|---|---|
| 112 | system + history + user | 2 history msgs | `[system, user, assistant, user]` |
| 113 | blank entries dropped, last 12 kept | 15 history msgs | 12 history msgs, first is `m3` |
| 114 | non-assistant roles mapped to user | `system` history row | becomes `user` role |

---

## `src/services/omniroute.js`

### `trimReply(reply, cap)`
| # | Case | Input | Expected |
|---|---|---|---|
| 54 | within cap unchanged | `('short',120)` | `'short'` |
| 55 | long reply → first sentence if it fits | sentence ≤ cap | returns first sentence only |
| 56 | first sentence > cap → hard slice | cap 10, long sentence | exactly 10 chars |
| 57 | mid-word fallback | `'Hi. '+ 'x'×200`, cap 10 | length ≤ 10 |
| 58 | empty / nullish | `''`, `null`, `undefined` | passthrough |

### `chatCompletion(...)` (fetch mocked)
| # | Case | Setup | Expected |
|---|---|---|---|
| 59 | returns trimmed content | content `'  Hello  '` | `'Hello'` |
| 60 | throws on non-2xx | status 500 | rejects, message matches `/LLM 500/` |
| 61 | missing choices | `{}` | `''` |

### `askModel(user, messages)` (fetch mocked)
| # | Case | Setup | Expected |
|---|---|---|---|
| 62 | uses primary model + cap | replies 500 chars | requests `primary`, result ≤ hard cap |
| 63 | falls back on primary error | first call 500, second ok | returns fallback reply |
| 64 | rethrows without fallback | fallback == model | rejects |

### `completeJson(user, messages)` (fetch mocked)
| # | Case | Setup | Expected |
|---|---|---|---|
| 65 | bare JSON parsed | content `{"name":"Rita"}` | `{name:'Rita'}` |
| 66 | markdown fences stripped | ` ```json … ``` ` | parsed object |
| 67 | JSON embedded in prose | `Sure: {"a":1,"b":[1,2]}` | parsed object |
| 68 | retries on empty → success on 3rd | two empties then JSON | succeeds after exactly 3 calls |
| 69 | throws after 3 non-JSON | always `'not json'` | rejects `/did not return a JSON object/`, 3 calls |
| 70 | throws on invalid JSON | `{"broken": }` | rejects `/invalid JSON/` |

### `testLlmConfig({ llm_base_url, llm_bearer, model })` — new-gateway smoke test (fetch mocked)
| # | Case | Setup | Expected |
|---|---|---|---|
| 115 | success returns ok + reply + latency | endpoint returns `OK` | `ok:true`, reply `'OK'`, `latencyMs` number |
| 116 | uses supplied base/model/bearer | capture URL+body+auth | URL ends `/v1/chat/completions`, model + bearer correct |
| 117 | fails cleanly on endpoint error | status 502 | rejects `/LLM 502/` |
| 118 | default model | model omitted | body uses `big-pickle` |

---

## `src/services/gateway.js`

### `maskSecret(secret)`
| # | Case | Input | Expected |
|---|---|---|---|
| 71 | empty/nullish | `''`, `undefined`, `null` | `''` |
| 72 | short secrets fully masked | `'abc'`, 8 chars | `'••••••••'` |
| 73 | long secrets keep 4+4 | 16 chars | `'abcd••••••mnop'` |
| 74 | never leaks the middle | long key | middle substring absent, length = 14 |

---

## `src/auth.js`

### `signToken(user)`
| # | Case | Input | Expected |
|---|---|---|---|
| 75 | verifies with app secret | user id+email | decodes to `sub`, `email` |
| 76 | has expiry | any user | numeric `exp` in the future |
| 77 | distinct users → distinct tokens | two ids | tokens differ |

### `publicUser(u)`
| # | Case | Input | Expected |
|---|---|---|---|
| 78 | whitelist (no password_hash) | user with `password_hash` + extra fields | excluded fields `undefined` |
| 79 | role defaults to user | no role | `role:'user'` |

### `requireAdmin(req, res, next)` (middleware, no DB)
| # | Case | Setup | Expected |
|---|---|---|---|
| 80 | admin passes | `req.user.role='admin'` | `next()` called |
| 81 | non-admin blocked | `role='user'` | 403, `next()` not called |
| 82 | no user blocked | `req.user=null` | 403, `next()` not called |

---

## `src/routes/characters.js`

### `slugify(s)`
| # | Case | Input | Expected |
|---|---|---|---|
| 83 | lowercases + dashes | `'Sushmita Sen'`, `'Hello, World! 2024'` | `'sushmita-sen'`, `'hello-world-2024'` |
| 84 | trims edge dashes | `'--name--'`, `'  spaced  '` | `'name'`, `'spaced'` |
| 85 | empty fallback | `''`, `undefined`, `null` | `'char'` |
| 86 | digits + mixed | `'Ri&#39;ta'`, `'Café 42'` | `'ri-39-ta'`, `'caf-42'` |

### `asArray(v)`
| # | Case | Input | Expected |
|---|---|---|---|
| 87 | array passthrough | `[{x:1}]` | same reference |
| 88 | non-arrays → `[]` | `null`, `undefined`, `'nope'`, `{}` | `[]` |

### `jsonb(v)`
| # | Case | Input | Expected |
|---|---|---|---|
| 89 | string passthrough | `'[1,2]'` | unchanged |
| 90 | arrays/objects encoded | array / object | JSON string |
| 91 | nullish → JSON null | `null`, `undefined` | `'null'` |

### `normalizeCharacter(c)`
| # | Case | Input | Expected |
|---|---|---|---|
| 92 | null passthrough | `null`, `undefined` | unchanged |
| 93 | legacy object→array coercion | object-shaped `example_messages` etc. | all array-typed (the character-edit bug regression) |
| 94 | well-formed arrays untouched | real array | same reference |

---

## `src/routes/admin.js`

### `num(q, dflt, max)`
| # | Case | Input | Expected |
|---|---|---|---|
| 95 | defaults on junk | `undefined`, `null`, `'abc'`, `'0'`, `'-5'`, `''` | `dflt` |
| 96 | parses positives | `'10'`, `42` | parsed number |
| 97 | clamps to max | `'500'` with max 100 / 99999 with max 1000 | 100 / 1000 |

---

## `test/db-integration.test.js` (live Postgres)

| # | Case | What it verifies |
|---|---|---|
| 98 | notifications full lifecycle | `createNotification` → `listNotifications` → `unreadCount` → `markRead([id])` → `unreadCount == 0`; fresh user isolation |
| 99 | markRead all | two unread → `markRead(null)` → all `read`, unread 0 |
| 100 | pagination | 5 rows with `limit:3, page:2` → page 2 has 3 items, `pages ≥ 2` |
| 101 | `countQuery` | inserts 3 messages → wrapped count returns 3 |
| 102 | characters jsonb round-trip | insert social_links/source_links/example_messages/languages/tags → deep-equal on read |
| 103 | dynamic SET update (bind regression) | 17-field update with `$3..$19` placeholders → no bind-mismatch, values correct |
| 104 | playground thread persist + clear | 3 rows inserted in order → read back ordered; delete → 0 rows |
| 105 | live chat aggregation | 3 msgs in `977x@c.us` + 1 in `other@c.us` → group-by returns 2 chats, main has `n=3`, full history ordered by `created_at` |

The 17-field update case (#103) locks in the fix for the `"bind message supplies 18 parameters, but prepared statement requires 17"` bug that broke character editing.

---

## Real bugs these tests caught (and fixed)

1. **Character edit `18 vs 17` bind error** — `UPDATE … SET k=$2` collided with `user_id=$2` in the `WHERE`, so the params array had one extra entry. Fixed by offsetting SET placeholders to `$3…` (`src/routes/characters.js`).
2. **`trimReply` bypassed the hard cap** for long unpunctuated replies (returned a >cap first "sentence"). Now hard-caps correctly (`src/services/omniroute.js`).
3. **Malformed social links leaked `undefined:`** into the system prompt. Now label/type fall back to `'Link'` (`src/services/bridge.js`).
4. **jsonb array writes broke** because node-postgres serializes JS arrays as Postgres array literals, not JSON — explicitly `JSON.stringify`ed jsonb columns in the characters route.
5. **`renderExamples` pageerror** when `example_messages` was stored as a legacy object — normalized to arrays on read.
