import { query } from '../db.js';
import { askModel } from './omniroute.js';
import * as openwa from './openwa.js';
import { config } from '../config.js';
import { createNotification, notifyOwnerAndAdmins } from './notifications.js';

const ONLINE = new Set(['ready', 'active', 'connected']);
export function isOnline(status) {
  return ONLINE.has(String(status || '').toLowerCase());
}
const RECONNECT_WAIT_MS = Number(process.env.RECONNECT_WAIT_MS || 8000);

// ── Prompt building ──────────────────────────────────────────────

export function buildSystemPrompt(character) {
  if (!character) return 'You are a friendly WhatsApp assistant. Keep replies short.';
  const p = [];
  p.push(`You are ${character.name}. You are a real person chatting on WhatsApp from your phone. Never reveal that you are an AI, bot, assistant, language model, or automated system.`);
  if (character.bio) p.push(`BIO: ${character.bio}`);
  if (character.languages?.length) p.push(`LANGUAGES: Only reply in ${character.languages.join(' or ')}. Match the user's language.`);
  if (character.personality) p.push(`PERSONALITY: ${character.personality}`);
  if (character.reply_style) p.push(`REPLY STYLE: ${character.reply_style}`);
  if (character.extra_rules) p.push(`EXTRA RULES: ${character.extra_rules}`);
  if (character.knowledge_base) p.push(`VERIFIED KNOWLEDGE (base all factual answers ONLY on this):\n${character.knowledge_base}`);
  const links = Array.isArray(character.social_links) ? character.social_links.filter(x => x && x.url) : [];
  if (links.length) {
    p.push(`SOCIAL LINKS (share the relevant link naturally when asked or when useful — these are real, verified handles):\n${links.map(x => `${x.label || x.type || 'Link'}: ${x.url}`).join('\n')}`);
  }
  if (character.drive_link) {
    p.push(`MEDIA: You have a media gallery at ${character.drive_link}. If the user asks for a photo, picture, image or media, reply with your caption then a line exactly like:\n[IMG:${character.drive_link}]\nThe bridge will send the image automatically. Do not add [IMG] otherwise.`);
  }
  if (character.example_messages?.length) {
    p.push(`EXAMPLE CONVERSATION (mimic this style):\n${character.example_messages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n')}`);
  }
  p.push('Always sound like a real human texter, never like a bot.');
  return p.join('\n');
}

// ── Character resolution ─────────────────────────────────────────

// slug (webhook) → session.character_id → chat_routing → user.default_character_id
export async function resolveCharacter(user, { slug, chatId, session }) {
  if (slug) {
    const r = await query('SELECT * FROM characters WHERE user_id=$1 AND slug=$2 AND active', [user.id, slug]);
    if (r.rows.length) return r.rows[0];
  }
  if (session?.character_id) {
    const r = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2 AND active', [session.character_id, user.id]);
    if (r.rows.length) return r.rows[0];
  }
  if (chatId) {
    const r = await query(
      'SELECT c.* FROM chat_routing cr JOIN characters c ON c.id=cr.character_id WHERE cr.user_id=$1 AND cr.chat_id=$2 AND c.active',
      [user.id, chatId]
    );
    if (r.rows.length) return r.rows[0];
  }
  if (user.default_character_id) {
    const r = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2 AND active', [user.default_character_id, user.id]);
    if (r.rows.length) return r.rows[0];
  }
  const r = await query('SELECT * FROM characters WHERE user_id=$1 AND active ORDER BY created_at LIMIT 1', [user.id]);
  return r.rows[0] || null;
}

// ── Memory ───────────────────────────────────────────────────────

async function fetchHistory(user, session, chatId, excludeBody) {
  const limit = user.memory_limit || 40;
  try {
    const rows = await openwa.fetchChatHistory({
      base: user.openwa_base_url, apiKey: user.openwa_api_key,
      sessionId: session.openwa_session_id, chatId, limit,
    });
    const history = [];
    for (const row of rows) {
      const text = String(row.body || '').trim();
      if (!text) continue;
      if (excludeBody && text === excludeBody && row.direction === 'incoming') continue;
      const role = row.direction === 'outgoing' ? 'assistant' : 'user';
      const last = history[history.length - 1];
      if (last && last.role === role) last.content += `\n${text}`;
      else history.push({ role, content: text });
    }
    return history.slice(-limit);
  } catch {
    return [];
  }
}

// ── Typing simulation ────────────────────────────────────────────

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Deterministic-ish schedule of human-like phases for a reply of given length.
// Returns [] when typing is disabled. Pure + unit-testable (no network).
export function typingSchedule(typing, replyLength) {
  const t = typing || {};
  if (t.enabled === false) return [];
  const readRange = (Array.isArray(t.readDelayMs) && t.readDelayMs.length === 2)
    ? [Math.max(0, t.readDelayMs[0]), Math.max(0, t.readDelayMs[1])]
    : [2000, 5000];
  const falseStart = Number.isFinite(t.falseStartChance) ? t.falseStartChance : 0.35;
  const minT = t.minTypingMs > 0 ? t.minTypingMs : 2000;
  const maxT = t.maxTypingMs > 0 ? t.maxTypingMs : 8000;
  if (readRange[1] < readRange[0]) readRange[1] = readRange[0];

  const phases = [
    { label: 'Reading', ms: rand(readRange[0], readRange[1]) },
    { label: 'Thinking', ms: rand(1000, 2600) },
  ];
  if (Math.random() < falseStart) phases.push({ label: 'Starting to type', ms: rand(800, 2200) });
  const words = Math.max(1, Math.ceil((replyLength || 0) / 5));
  phases.push({ label: 'Typing', ms: Math.min(maxT, Math.max(minT, words * rand(160, 300))) });
  return phases;
}

async function humanTypingPattern(user, session, chatId, replyLength, typingProfile) {
  if (user.typing?.enabled === false) return;
  const t = typingProfile || user.typing || {};
  const readRange = t.readDelayMs || [2000, 5000];
  const falseStart = t.falseStartChance ?? 0.35;
  const minT = t.minTypingMs || 2000;
  const maxT = t.maxTypingMs || 8000;
  const opts = { base: user.openwa_base_url, apiKey: user.openwa_api_key, sessionId: session.openwa_session_id, chatId };

  await sleep(rand(readRange[0], readRange[1]));
  await openwa.sendTyping({ ...opts, state: 'typing' });
  await sleep(rand(1500, 3500));
  await openwa.sendTyping({ ...opts, state: 'paused' });
  await sleep(rand(1500, 4000));
  if (Math.random() < falseStart) {
    await openwa.sendTyping({ ...opts, state: 'typing' });
    await sleep(rand(1000, 2500));
    await openwa.sendTyping({ ...opts, state: 'paused' });
    await sleep(rand(1000, 2500));
  }
  await openwa.sendTyping({ ...opts, state: 'typing' });
  const words = Math.max(1, Math.ceil(replyLength / 5));
  await sleep(Math.min(maxT, Math.max(minT, words * rand(180, 320))));
  await openwa.sendTyping({ ...opts, state: 'paused' });
  await sleep(rand(400, 1200));
}

// ── Event handling (inbound message) ─────────────────────────────

export function splitMediaTokens(reply) {
  const urls = [];
  const text = String(reply || '')
    .replace(/\[IMG:([^\]]+)\]/g, (_, u) => { urls.push(String(u).trim()); return ''; })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, media: urls };
}

export function driveDirectUrl(link) {
  const m = String(link || '').match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return String(link || '').trim();
}

// Shared: assemble the exact message array the real webhook pipeline uses.
// Both handleInboundMessage and the playground POST use this — one source of truth.
export function buildCharacterMessages(character, history, text) {
  const msgs = [{ role: 'system', content: buildSystemPrompt(character) }];
  for (const h of (history || []).slice(-12)) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.content || '').trim();
    if (content) msgs.push({ role, content });
  }
  msgs.push({ role: 'user', content: text });
  return msgs;
}

// Phrases that would instantly reveal the sender is a bot/AI to a real user.
const NON_HUMAN = [
  /\bas an ai\b/i, /\bi am (an |a )?ai\b/i, /\bi['’]m (just |only |)an? ai\b/i, /\bi (am|['’]m) (an |a )?language model\b/i,
  /\bas a language model\b/i, /\bchatgpt\b/i, /\bopenai\b/i, /\bapi key\b/i,
  /\binsufficient quota\b/i, /\bquota exceeded\b/i, /\brate limit\b/i, /\b402 payment required\b/i,
  /\b429\b/, /\btoo many requests\b/i, /\bauthentication failed\b/i, /\binvalid api key\b/i,
  /\berror\s*\d{3}\b/i, /\bi cannot (access|process|provide) .*(personal|private|confidential)/i,
];
export function looksNonHuman(text) {
  return NON_HUMAN.some(re => re.test(String(text || '')));
}

// Decide whether a model reply is safe to send to a real user. Returns null if OK.
export function replyProblem(reply) {
  const text = String(reply || '').trim();
  if (!text) return 'empty reply';
  if (looksNonHuman(text)) return 'reply exposed AI/error content';
  return null;
}

// Generate a reply, type it out, send it. Returns the sent text, or null when the
// reply was suppressed (empty / bot-like / model failure) — in which case the end
// user receives NOTHING and the owner + admins are notified instead.
export async function sendHumanReply(user, { session, chatId, character, messages }) {
  let reply;
  try {
    reply = await askModel(user, messages);
  } catch (e) {
    const err = String(e?.message || e || '').slice(0, 400);
    await notifyOwnerAndAdmins(user.id, {
      type: 'llm_failed', level: 'error', sessionId: session?.id || null,
      title: 'AI reply failed — nothing was sent',
      body: `${chatId}: no reply was delivered (staying silent). ${err}`,
    });
    await logLine(`[llm-fail] ${user.email} ${chatId}: ${err}`);
    return null;
  }

  const problem = replyProblem(reply);
  if (problem) {
    await notifyOwnerAndAdmins(user.id, {
      type: problem === 'empty reply' ? 'llm_empty' : 'llm_exposed', level: 'warning', sessionId: session?.id || null,
      title: problem === 'empty reply' ? 'Empty AI reply suppressed' : 'Bot-like reply suppressed',
      body: `${chatId}: the model produced "${problem}". The message was NOT sent to the user to keep it human. Raw reply: ${String(reply || '').slice(0, 200)}`,
    });
    await logLine(`[llm-suppress] ${user.email} ${chatId}: ${problem}`);
    return null;
  }

  const { text: replyText, media } = splitMediaTokens(reply);
  await humanTypingPattern(user, session, chatId, replyText.length, character?.typing_profile);
  if (replyText) {
    await openwa.sendText({ base: user.openwa_base_url, apiKey: user.openwa_api_key, sessionId, chatId, text: replyText });
  }
  for (const url of media.slice(0, 2)) {
    const direct = driveDirectUrl(url);
    try {
      await openwa.sendMedia({ base: user.openwa_base_url, apiKey: user.openwa_api_key, sessionId, chatId, file: direct, caption: replyText.slice(0, 200) });
      await logLine(`[media] ${user.email} ${chatId} sent image`);
    } catch (e) {
      await logLine(`[media] ${user.email} send failed (${e.message}); sending link as text`);
      await openwa.sendText({ base: user.openwa_base_url, apiKey: user.openwa_api_key, sessionId, chatId, text: direct }).catch(() => {});
    }
  }
  await persistMessage(user.id, session?.id, chatId, 'outgoing', replyText, character?.id || null);
  return replyText;
}

export async function handleInboundMessage(user, event, slug) {
  const data = event.data || {};
  if (event.event !== 'message.received' || !data) return;
  if (data.fromMe) return;
  if (data.type && data.type !== 'text') return;
  const text = String(data.body || '').trim();
  if (!text) return;
  const chatId = data.chatId || data.from;
  if (!chatId) return;
  if (!user.openwa_base_url || !user.openwa_api_key) {
    throw new Error('tenant has no OpenWA base/api key configured');
  }

  const sessionId = event.sessionId || data.sessionId;
  let session = null;
  if (sessionId) {
    const r = await query('SELECT * FROM wa_sessions WHERE user_id=$1 AND openwa_session_id=$2', [user.id, sessionId]);
    session = r.rows[0] || null;
    if (!session) session = await upsertSession(user, sessionId, { name: sessionId, status: 'active' });
  }

  const character = await resolveCharacter(user, { slug, chatId, session });

  await logLine(`[msg] ${user.email} ${sessionId} <- ${chatId}: ${text.slice(0, 60)} (webhook:${slug || 'generic'} → char: ${character?.name || 'NONE'})`);

  const history = await fetchHistory(user, session, chatId, text);
  const messages = buildCharacterMessages(character, history, text);

  await persistMessage(user.id, session?.id, chatId, 'incoming', text, character?.id || null, data.id || data.key || null);

  const sent = await sendHumanReply(user, { session, chatId, character, messages });
  await logLine(`[llm] -> ${user.email} ${chatId}: ${sent ? sent.slice(0, 60) : '(suppressed / not sent)'}`);

  if (session?.id) {
    await query('UPDATE wa_sessions SET last_seen=now() WHERE id=$1', [session.id]);
  }
}

export async function persistMessage(userId, sessionDbId, chatId, direction, body, characterId, remoteId) {
  await query(
    'INSERT INTO messages (user_id, session_id, chat_id, direction, body, character_id, remote_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, sessionDbId || null, chatId, direction, body, characterId || null, remoteId || null]
  );
  if (characterId) {
    await query('UPDATE characters SET last_active_at=now() WHERE id=$1', [characterId]);
  }
}

// ── Session discovery / webhook registration ─────────────────────

export async function upsertSession(user, openwaSessionId, fields = {}) {
  const existing = await query('SELECT * FROM wa_sessions WHERE user_id=$1 AND openwa_session_id=$2', [user.id, openwaSessionId]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    const before = row.status;
    const after = fields.status || row.status;
    const next = { ...row, ...fields };
    let disconnectedAt = row.disconnected_at;
    if (before !== after && isOnline(before) && !isOnline(after)) {
      disconnectedAt = new Date();
      await createNotification(user.id, {
        sessionId: row.id, type: 'session_disconnected', level: 'warning',
        title: `Session disconnected: ${next.name || openwaSessionId}`,
        body: `Your OpenWA session "${next.name || openwaSessionId}" went offline (${after}). New messages will not be answered until it reconnects.`,
      });
      await logLine(`[health] ${user.email} session ${openwaSessionId} DISCONNECTED (${before} → ${after})`);
    } else if (before !== after && !isOnline(before) && isOnline(after)) {
      disconnectedAt = null;
      await createNotification(user.id, {
        sessionId: row.id, type: 'session_reconnected', level: 'success',
        title: `Session reconnected: ${next.name || openwaSessionId}`,
        body: `Session is back online. Checking for messages missed while it was away…`,
      });
      await logLine(`[health] ${user.email} session ${openwaSessionId} RECONNECTED (${before} → ${after})`);
      setTimeout(() => catchUpSession(user, { ...row, ...fields }).catch(e =>
        logLine(`[catchup] ${user.email} failed: ${e.message}`)
      ), RECONNECT_WAIT_MS);
    }
    await query(
      `UPDATE wa_sessions SET name=$1, phone=$2, status=$3, character_id=$4, last_seen=$5, disconnected_at=$6, updated_at=now() WHERE id=$7`,
      [next.name, next.phone, next.status, next.character_id, next.last_seen, disconnectedAt, row.id]
    );
    const refreshed = await query('SELECT * FROM wa_sessions WHERE id=$1', [row.id]);
    return refreshed.rows[0];
  }
  const ins = await query(
    'INSERT INTO wa_sessions (user_id, openwa_session_id, name, phone, status, character_id, disconnected_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [user.id, openwaSessionId, fields.name || openwaSessionId, fields.phone || '', fields.status || 'unknown',
     fields.character_id || null, fields.disconnected_at || (fields.status && !isOnline(fields.status) ? new Date() : null)]
  );
  return ins.rows[0];
}

export async function discoverSessions(user) {
  if (!user.openwa_base_url || !user.openwa_api_key) return [];
  const list = await openwa.listSessions(user.openwa_base_url, user.openwa_api_key);
  const out = [];
  for (const s of list) {
    const id = s.id || s.name;
    if (!id) continue;
    out.push(await upsertSession(user, id, { name: s.name || id, phone: s.phone || '', status: s.status || 'unknown' }));
  }
  return out;
}

export async function registerWebhooksForSession(user, waSession, characterIds) {
  const base = user.openwa_base_url, apiKey = user.openwa_api_key, sid = waSession.openwa_session_id;
  const existing = await openwa.listSessionWebhooks(base, apiKey, sid);
  for (const w of existing) {
    if (String(w.url || '').includes(`:${config.port}`)) {
      await openwa.deleteSessionWebhook(base, apiKey, sid, w.id).catch(() => {});
    }
  }
  const urls = [];
  const push = async url => {
    await openwa.createSessionWebhook(base, apiKey, sid, url, user.webhook_secret || undefined);
    urls.push(url);
  };
  if (characterIds && characterIds.length) {
    for (const cid of characterIds) {
      const c = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [cid, user.id]);
      if (c.rows.length) await push(webhookUrl(user, c.rows[0]));
    }
  } else {
    await push(webhookUrl(user, null));
    const chars = await query('SELECT * FROM characters WHERE user_id=$1 AND active', [user.id]);
    for (const c of chars.rows) await push(webhookUrl(user, c));
  }
  await query('UPDATE wa_sessions SET webhook_registered=true, updated_at=now() WHERE id=$1', [waSession.id]);
  return urls;
}

export function webhookUrl(user, character) {
  const base = config.webhookBase;
  return character ? `${base}/webhook/${user.webhook_token}/${character.slug}` : `${base}/webhook/${user.webhook_token}`;
}

// ── Reconnect catch-up ───────────────────────────────────────────
// After a session comes back online we wait a few seconds for pending
// deliveries, then re-read recent history per chat, persist anything we
// missed while offline, and reply once to the latest missed message.

async function messageExists(userId, chatId, body, remoteId) {
  if (remoteId) {
    const r = await query('SELECT 1 FROM messages WHERE user_id=$1 AND remote_id=$2', [userId, remoteId]);
    if (r.rows.length) return true;
  }
  const r = await query(
    `SELECT 1 FROM messages WHERE user_id=$1 AND chat_id=$2 AND direction='incoming' AND body=$3
     AND created_at > now() - interval '72 hours'`,
    [userId, chatId, body]
  );
  return r.rows.length > 0;
}

async function collectMissed(user, sessionRow, chatId) {
  const since = sessionRow.disconnected_at
    ? new Date(new Date(sessionRow.disconnected_at).getTime() - 5000)
    : null;
  let rows;
  try {
    rows = await openwa.fetchChatHistory({
      base: user.openwa_base_url, apiKey: user.openwa_api_key,
      sessionId: sessionRow.openwa_session_id, chatId, limit: 100,
    });
  } catch {
    return [];
  }
  const missed = [];
  for (const row of rows) {
    const text = String(row.body || '').trim();
    if (!text) continue;
    if (row.direction === 'outgoing' || row.fromMe) continue;
    const ts = row.createdAt || row.created_at || row.timestamp;
    if (since && ts && new Date(ts).getTime() < since.getTime()) continue;
    if (await messageExists(user.id, chatId, text, row.id || row.key || null)) continue;
    missed.push({ body: text, remote_id: row.id || row.key || null });
  }
  return missed;
}

export async function catchUpSession(user, sessionRow) {
  if (!user.openwa_base_url || !user.openwa_api_key) return;
  await sleep(RECONNECT_WAIT_MS);

  const fresh = await query('SELECT * FROM wa_sessions WHERE id=$1', [sessionRow.id]);
  const s = fresh.rows[0];
  if (!s || !isOnline(s.status)) {
    await logLine(`[catchup] ${user.email} ${sessionRow.openwa_session_id}: session not online, skipping`);
    return;
  }

  const chats = await query('SELECT DISTINCT chat_id FROM messages WHERE user_id=$1 AND session_id=$2', [user.id, sessionRow.id]);
  let missedTotal = 0;
  const replied = [];
  for (const { chat_id } of chats.rows) {
    try {
      const missed = await collectMissed(user, s, chat_id);
      if (!missed.length) continue;
      missedTotal += missed.length;
      for (const m of missed) {
        await persistMessage(user.id, sessionRow.id, chat_id, 'incoming', m.body, null, m.remote_id);
      }
      const character = await resolveCharacter(user, { chatId: chat_id, session: s });
      const latest = missed[missed.length - 1];
      const history = await fetchHistory(user, sessionRow, chat_id, latest.body);
      const messages = [{ role: 'system', content: buildSystemPrompt(character) }, ...history, { role: 'user', content: latest.body }];
      const sent = await sendHumanReply(user, { session: s, chatId: chat_id, character, messages });
      if (sent) replied.push(chat_id);
      await logLine(`[catchup] ${user.email} ${chat_id}: replied to ${missed.length} missed msg(s)`);
    } catch (e) {
      await logLine(`[catchup] ${user.email} ${chat_id}: ${e.message}`);
    }
  }
  if (missedTotal > 0) {
    await createNotification(user.id, {
      sessionId: sessionRow.id, type: 'catchup_missed', level: 'info',
      title: `Caught up on ${missedTotal} missed message${missedTotal === 1 ? '' : 's'}`,
      body: `Replied in ${replied.length} chat${replied.length === 1 ? '' : 's'} after reconnect.`,
    });
  }
}

// ── Logs (in-memory ring, DB-agnostic for dashboard) ─────────────

const logBuffer = [];
const MAX_LOGS = 500;
export async function logLine(line) {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  logBuffer.push(stamped);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  console.log(stamped);
}
export const getLogs = (n = 50) => logBuffer.slice(-n);
