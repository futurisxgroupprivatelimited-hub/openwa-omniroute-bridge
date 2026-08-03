import { query } from '../db.js';
import { askModel } from './omniroute.js';
import * as openwa from './openwa.js';
import { config } from '../config.js';

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  const systemPrompt = buildSystemPrompt(character);
  const messages = [{ role: 'system', content: systemPrompt }];
  if (history.length) messages.push(...history);
  messages.push({ role: 'user', content: text });

  await persistMessage(user.id, session?.id, chatId, 'incoming', text, character?.id || null);

  const reply = await askModel(user, messages);
  await humanTypingPattern(user, session, chatId, reply.length, character?.typing_profile);
  await openwa.sendText({ base: user.openwa_base_url, apiKey: user.openwa_api_key, sessionId, chatId, text: reply });
  await persistMessage(user.id, session?.id, chatId, 'outgoing', reply, character?.id || null);
  await logLine(`[llm] -> ${user.email} ${chatId}: ${reply.slice(0, 60)}`);

  if (session?.id) {
    await query('UPDATE wa_sessions SET last_seen=now() WHERE id=$1', [session.id]);
  }
}

export async function persistMessage(userId, sessionDbId, chatId, direction, body, characterId) {
  await query(
    'INSERT INTO messages (user_id, session_id, chat_id, direction, body, character_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, sessionDbId || null, chatId, direction, body, characterId || null]
  );
}

// ── Session discovery / webhook registration ─────────────────────

export async function upsertSession(user, openwaSessionId, fields = {}) {
  const existing = await query('SELECT * FROM wa_sessions WHERE user_id=$1 AND openwa_session_id=$2', [user.id, openwaSessionId]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    const next = { ...row, ...fields };
    await query(
      `UPDATE wa_sessions SET name=$1, phone=$2, status=$3, character_id=$4, last_seen=$5, updated_at=now() WHERE id=$6`,
      [next.name, next.phone, next.status, next.character_id, next.last_seen, row.id]
    );
    const refreshed = await query('SELECT * FROM wa_sessions WHERE id=$1', [row.id]);
    return refreshed.rows[0];
  }
  const ins = await query(
    'INSERT INTO wa_sessions (user_id, openwa_session_id, name, phone, status, character_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [user.id, openwaSessionId, fields.name || openwaSessionId, fields.phone || '', fields.status || 'unknown', fields.character_id || null]
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
