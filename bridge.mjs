import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 3001);
const OPENWA_BASE = (process.env.OPENWA_BASE_URL || 'http://localhost:2785').replace(/\/$/, '');
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || '';
const OMNIRoute_BASE = (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const CHARACTERS_FILE = path.join(__dirname, 'characters.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const logBuffer = [];
const MAX_LOGS = 300;
const dedupe = new Map();
const stats = { messagesIn: 0, messagesOut: 0, llmCalls: 0, errors: 0, replies: [] };

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let data = readJsonFile(SETTINGS_FILE, {
  model: 'big-pickle',
  fallbackModel: 'auto',
  memoryLimit: 40,
  maxTokens: 80,
  replyHardCap: 120,
  defaultCharacter: 'barsha',
  typing: { enabled: true, readDelayMs: [2000, 5000], falseStartChance: 0.35, minTypingMs: 2000, maxTypingMs: 8000 },
});
let chars = readJsonFile(CHARACTERS_FILE, { characters: [], chatRouting: {} });

function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(stamped);
  logBuffer.push(stamped);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getActiveCharacters() {
  return (chars.characters || []).filter(c => c.active !== false);
}

function characterForChat(chatId) {
  const routed = chars.chatRouting?.[chatId];
  if (routed) {
    const c = getActiveCharacters().find(x => x.id === routed);
    if (c) return c;
  }
  const def = data.defaultCharacter
    ? getActiveCharacters().find(c => c.id === data.defaultCharacter)
    : undefined;
  if (def) return def;
  return getActiveCharacters()[0] || null;
}

function buildSystemPrompt(character) {
  if (!character) return 'You are a friendly WhatsApp assistant. Keep replies short.';
  const parts = [];
  parts.push(`You are ${character.name}. You are a real person chatting on WhatsApp from your phone. Never reveal that you are an AI, bot, assistant, language model, or automated system.`);
  if (character.bio) parts.push(`BIO: ${character.bio}`);
  if (character.languages?.length) {
    parts.push(`LANGUAGES: Only reply in ${character.languages.join(' or ')}. Match the user's language.`);
  }
  if (character.personality) parts.push(`PERSONALITY: ${character.personality}`);
  if (character.replyStyle) parts.push(`REPLY STYLE: ${character.replyStyle}`);
  if (character.extraRules) parts.push(`EXTRA RULES: ${character.extraRules}`);
  if (character.exampleMessages?.length) {
    const examples = character.exampleMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');
    parts.push(`EXAMPLE CONVERSATION (mimic this style):\n${examples}`);
  }
  parts.push('Always sound like a real human texter, never like a bot.');
  return parts.join('\n');
}

function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isDuplicate(key) {
  if (!key) return false;
  if (dedupe.has(key)) return true;
  dedupe.set(key, Date.now());
  setTimeout(() => dedupe.delete(key), 300000);
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function httpJson(method, url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
          ...headers,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body });
          else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
        });
      }
    );
    req.setTimeout(120000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

const postJson = (url, payload, headers = {}) => httpJson('POST', url, payload, headers);

async function sendTypingState(sessionId, chatId, state) {
  try {
    await postJson(`${OPENWA_BASE}/api/sessions/${encodeURIComponent(sessionId)}/chats/typing`, { chatId, state }, { 'X-API-Key': OPENWA_API_KEY });
  } catch {
    // best effort
  }
}

async function humanTypingPattern(sessionId, chatId, replyLength, typingProfile) {
  if (data.typing && data.typing.enabled === false) return;
  const readRange = typingProfile?.readDelayMs || data.typing?.readDelayMs || [2000, 5000];
  const falseStart = typingProfile?.falseStartChance ?? data.typing?.falseStartChance ?? 0.35;
  const minT = typingProfile?.minTypingMs || data.typing?.minTypingMs || 2000;
  const maxT = typingProfile?.maxTypingMs || data.typing?.maxTypingMs || 8000;

  log('[typing] reading message...');
  await sleep(rand(readRange[0], readRange[1]));
  log('[typing] started typing...');
  await sendTypingState(sessionId, chatId, 'typing');
  await sleep(rand(1500, 3500));
  log('[typing] deleted text, thinking...');
  await sendTypingState(sessionId, chatId, 'paused');
  await sleep(rand(1500, 4000));
  if (Math.random() < falseStart) {
    log('[typing] false start — typing then deleting...');
    await sendTypingState(sessionId, chatId, 'typing');
    await sleep(rand(1000, 2500));
    await sendTypingState(sessionId, chatId, 'paused');
    await sleep(rand(1000, 2500));
  }
  log('[typing] final typing...');
  await sendTypingState(sessionId, chatId, 'typing');
  const words = Math.max(1, Math.ceil(replyLength / 5));
  const typingTime = Math.min(maxT, Math.max(minT, words * rand(180, 320)));
  await sleep(typingTime);
  log('[typing] re-reading before send...');
  await sendTypingState(sessionId, chatId, 'paused');
  await sleep(rand(400, 1200));
}

async function fetchChatHistory(sessionId, chatId, excludeBody) {
  const limit = data.memoryLimit || 40;
  const qs = new URLSearchParams({ chatId, limit: String(limit) });
  try {
    const { body } = await httpJson('GET', `${OPENWA_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?${qs}`, null, { 'X-API-Key': OPENWA_API_KEY });
    const parsed = JSON.parse(body);
    const rows = Array.isArray(parsed) ? parsed : parsed.messages || [];
    const chronological = [...rows].reverse();
    const history = [];
    for (const row of chronological) {
      const text = String(row.body || '').trim();
      if (!text) continue;
      if (excludeBody && text === excludeBody && row.direction === 'incoming') continue;
      const role = row.direction === 'outgoing' ? 'assistant' : 'user';
      const last = history[history.length - 1];
      if (last && last.role === role) last.content = `${last.content}\n${text}`;
      else history.push({ role, content: text });
    }
    return history.slice(-limit);
  } catch (e) {
    log(`[memory] fetch failed: ${e.message}`);
    return [];
  }
}

async function askOmniRoute(userText, history, character) {
  const systemPrompt = buildSystemPrompt(character);
  const messages = [{ role: 'system', content: systemPrompt }];
  if (history && history.length) messages.push(...history);
  messages.push({ role: 'user', content: userText });
  stats.llmCalls++;
  const model = data.model || 'big-pickle';
  try {
    const { body } = await postJson(
      `${OMNIRoute_BASE}/v1/chat/completions`,
      { model, stream: false, messages, max_tokens: data.maxTokens || 80 },
      { Authorization: 'Bearer omniroute' }
    );
    const parsed = JSON.parse(body);
    let reply = parsed.choices?.[0]?.message?.content?.trim() || '';
    const cap = data.replyHardCap || 120;
    if (reply.length > cap) {
      const first = reply.split(/[.!?\n]/)[0];
      reply = first.length > 10 ? first.trim() : reply.slice(0, cap);
    }
    return reply;
  } catch (err) {
    if (data.fallbackModel && data.fallbackModel !== model) {
      log(`[llm] model ${model} failed (${err.message}), falling back to ${data.fallbackModel}`);
      const { body } = await postJson(
        `${OMNIRoute_BASE}/v1/chat/completions`,
        { model: data.fallbackModel, stream: false, messages, max_tokens: data.maxTokens || 80 },
        { Authorization: 'Bearer omniroute' }
      );
      const parsed = JSON.parse(body);
      let reply = parsed.choices?.[0]?.message?.content?.trim() || '';
      const cap = data.replyHardCap || 120;
      if (reply.length > cap) {
        const first = reply.split(/[.!?\n]/)[0];
        reply = first.length > 10 ? first.trim() : reply.slice(0, cap);
      }
      return reply;
    }
    throw err;
  }
}

async function sendWhatsApp(sessionId, chatId, text) {
  if (!text) return;
  stats.messagesOut++;
  await postJson(`${OPENWA_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, { chatId, text }, { 'X-API-Key': OPENWA_API_KEY });
}

function handleMessage(event) {
  const { data } = event;
  if (event.event !== 'message.received' || !data) return;
  if (data.fromMe) return;
  if (data.type && data.type !== 'text') return;
  const text = String(data.body || '').trim();
  if (!text) return;
  const chatId = data.chatId || data.from;
  if (!chatId) return;
  const sessionId = event.sessionId;
  const character = characterForChat(chatId);

  stats.messagesIn++;
  log(`[msg] ${sessionId} <- ${chatId}: ${text.slice(0, 80)} (char: ${character ? character.name : 'NONE'})`);

  (async () => {
    const history = await fetchChatHistory(sessionId, chatId, text);
    log(`[memory] ${history.length} prior turns for ${chatId}`);
    const reply = await askOmniRoute(text, history, character);
    log(`[llm] -> ${reply.slice(0, 80)}`);
    await humanTypingPattern(sessionId, chatId, reply.length, character?.typingProfile);
    await sendWhatsApp(sessionId, chatId, reply);
    log(`[send] ok -> ${chatId}`);
    stats.replies.push({ at: Date.now(), chatId, character: character?.name, reply: reply.slice(0, 80) });
    if (stats.replies.length > 50) stats.replies.shift();
  })().catch(e => {
    stats.errors++;
    log(`[handle] failed: ${e.message}`);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, filePath, contentType) {
  try {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Static dashboard
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
    return;
  }

  // Health
  if (req.method === 'GET' && p === '/health') {
    json(res, 200, { ok: true, service: 'openwa-omniroute-bridge', memoryLimit: data.memoryLimit, model: data.model, stats });
    return;
  }

  // Logs
  if (req.method === 'GET' && p === '/logs') {
    const lines = Number(url.searchParams.get('lines') || 50);
    json(res, 200, { lines: logBuffer.slice(-lines) });
    return;
  }

  // Characters
  if (p === '/characters') {
    if (req.method === 'GET') { json(res, 200, chars); return; }
    if (req.method === 'PUT') {
      try {
        const raw = await readBody(req);
        const next = JSON.parse(raw.toString('utf8'));
        if (!next || !Array.isArray(next.characters)) { json(res, 400, { error: 'characters array required' }); return; }
        chars = next;
        writeJsonFile(CHARACTERS_FILE, chars);
        log('[bridge] characters updated via dashboard');
        json(res, 200, { ok: true, characters: chars.characters.length });
      } catch (e) { json(res, 400, { error: e.message }); }
      return;
    }
  }

  // Settings
  if (p === '/settings') {
    if (req.method === 'GET') { json(res, 200, data); return; }
    if (req.method === 'PUT') {
      try {
        const raw = await readBody(req);
        const next = JSON.parse(raw.toString('utf8'));
        data = { ...data, ...next };
        writeJsonFile(SETTINGS_FILE, data);
        log('[bridge] settings updated via dashboard');
        json(res, 200, { ok: true, ...data });
      } catch (e) { json(res, 400, { error: e.message }); }
      return;
    }
  }

  // Resolved config (system prompt of default character + settings)
  if (req.method === 'GET' && p === '/config') {
    const character = characterForChat('__default__');
    json(res, 200, {
      model: data.model,
      fallbackModel: data.fallbackModel,
      memoryLimit: data.memoryLimit,
      maxTokens: data.maxTokens,
      replyHardCap: data.replyHardCap,
      defaultCharacter: data.defaultCharacter,
      openwa: OPENWA_BASE,
      omniroute: OMNIRoute_BASE,
      character: character ? { id: character.id, name: character.name } : null,
      systemPrompt: character ? buildSystemPrompt(character) : '',
      stats,
    });
    return;
  }

  // Webhook
  if (req.method === 'POST' && p === '/webhook') {
    try {
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-openwa-signature'])) { json(res, 401, { error: 'invalid signature' }); return; }
      const event = JSON.parse(raw.toString('utf8'));
      const idem = req.headers['x-openwa-idempotency-key'];
      if (isDuplicate(idem)) { json(res, 200, { status: 'duplicate' }); return; }
      handleMessage(event);
      json(res, 200, { status: 'received' });
    } catch (e) {
      log(`[webhook] error: ${e.message}`);
      json(res, 400, { error: e.message });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  log(`[bridge] listening on http://localhost:${PORT}`);
  log(`[bridge] dashboard: http://localhost:${PORT}/`);
  log(`[bridge] OpenWA: ${OPENWA_BASE}`);
  log(`[bridge] OmniRoute: ${OMNIRoute_BASE}`);
  log(`[bridge] model: ${data.model} (fallback: ${data.fallbackModel})`);
  log(`[bridge] memory: last ${data.memoryLimit} msgs per chat`);
  log(`[bridge] characters: ${getActiveCharacters().map(c => c.name).join(', ') || 'NONE'}`);
});
