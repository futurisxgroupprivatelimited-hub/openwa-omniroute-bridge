import { config } from '../config.js';

const BASE = config.omnirouteBase;
const BEARER = config.omnirouteBearer;

export async function chatCompletion({ model, messages, maxTokens }) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({ model, stream: false, messages, max_tokens: maxTokens || 80 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OmniRoute ${res.status}: ${body.slice(0, 300)}`);
  }
  const parsed = await res.json();
  return (parsed.choices?.[0]?.message?.content || '').trim();
}

export async function askModel(user, messages) {
  const model = user.model || 'big-pickle';
  const fallback = user.fallback_model || 'auto';
  const maxTokens = user.max_tokens || 80;
  const cap = user.reply_hard_cap || 120;

  try {
    const reply = await chatCompletion({ model, messages, maxTokens });
    return trimReply(reply, cap);
  } catch (err) {
    if (fallback && fallback !== model) {
      const reply = await chatCompletion({ model: fallback, messages, maxTokens });
      return trimReply(reply, cap);
    }
    throw err;
  }
}

function trimReply(reply, cap) {
  if (!reply) return reply;
  if (reply.length <= cap) return reply;
  const first = reply.split(/[.!?\n]/)[0];
  return first.length > 10 ? first.trim() : reply.slice(0, cap);
}
