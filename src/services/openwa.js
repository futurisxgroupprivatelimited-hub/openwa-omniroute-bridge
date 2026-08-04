// Outbound calls to a tenant's own OpenWA instance (history, typing, send, sessions, webhooks).

async function jfetch(base, path, { method = 'GET', apiKey, body } = {}) {
  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) throw new Error(`OpenWA ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

export async function listSessions(base, apiKey) {
  const parsed = await jfetch(base, '/api/sessions', { apiKey });
  return Array.isArray(parsed) ? parsed : parsed?.sessions || [];
}

export async function fetchChatHistory({ base, apiKey, sessionId, chatId, limit }) {
  const qs = new URLSearchParams({ chatId, limit: String(limit || 40) });
  const parsed = await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/messages?${qs}`, { apiKey });
  const rows = Array.isArray(parsed) ? parsed : parsed?.messages || [];
  return [...rows].reverse();
}

export async function sendTyping({ base, apiKey, sessionId, chatId, state }) {
  try {
    await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/chats/typing`, {
      method: 'POST', apiKey, body: { chatId, state },
    });
  } catch { /* best effort */ }
}

export async function sendText({ base, apiKey, sessionId, chatId, text }) {
  await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
    method: 'POST', apiKey, body: { chatId, text },
  });
}

export async function sendMedia({ base, apiKey, sessionId, chatId, file, caption }) {
  await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-media`, {
    method: 'POST', apiKey, body: { chatId, file, caption },
  });
}

export async function listSessionWebhooks(base, apiKey, sessionId) {
  const parsed = await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`, { apiKey });
  return Array.isArray(parsed) ? parsed : parsed?.webhooks || [];
}

export async function createSessionWebhook(base, apiKey, sessionId, url, secret, events = ['message.received']) {
  await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`, {
    method: 'POST', apiKey, body: { url, events, secret },
  });
}

export async function deleteSessionWebhook(base, apiKey, sessionId, webhookId) {
  await jfetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`, {
    method: 'DELETE', apiKey,
  });
}
