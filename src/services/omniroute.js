import { getGateway } from './gateway.js';

export async function chatCompletion({ model, messages, maxTokens, base, bearer }) {
  const gw = await getGateway();
  const url = `${(base || gw.llm_base_url).replace(/\/$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer || gw.llm_bearer}` },
    body: JSON.stringify({ model, stream: false, messages, max_tokens: maxTokens || 80 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status} from ${url} (model=${model}): ${body.slice(0, 300)}`);
  }
  const parsed = await res.json();
  return (parsed.choices?.[0]?.message?.content || '').trim();
}

export async function askModel(user, messages, gatewayOverride) {
  const model = user.model || (await getGateway()).llm_default_model || 'antigravity/gemini-2.5-flash';
  const fallback = user.fallback_model || 'auto';
  const maxTokens = user.max_tokens || 80;
  const cap = user.reply_hard_cap || 120;

  // Retry empty responses (models occasionally answer a short / ambiguous message
  // with blank content). Try the primary model, then the fallback, then once more.
  const attempts = [
    { model },
    ...(fallback && fallback !== model ? [{ model: fallback }] : []),
    { model },
  ];
  const recovers = [
    '',
    '',
    'The user seems to expect an answer but you returned nothing. Reply naturally, in character, as a real person would on WhatsApp — 1-2 short sentences. If the message is unclear, ask a friendly clarifying question. NEVER reply with only an emoji or with empty content.',
  ];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const { model: m } = attempts[i];
    let msgs = messages;
    if (recovers[i]) msgs = [...messages, { role: 'user', content: recovers[i] }];
    try {
      const raw = await chatCompletion({ model: m, messages: msgs, maxTokens, ...gatewayOverride });
      const trimmed = trimReply(raw, cap);
      if (trimmed) return trimmed;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('LLM returned an empty response after retries');
}

// Smoke-test an arbitrary OpenAI-compatible endpoint before saving it as the gateway.
export async function testLlmConfig({ llm_base_url, llm_bearer, model } = {}) {
  const started = Date.now();
  const reply = await chatCompletion({
    model: model || 'antigravity/gemini-2.5-flash',
    base: llm_base_url || undefined,
    bearer: llm_bearer || undefined,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    maxTokens: 8,
  });
  return { ok: true, reply, latencyMs: Date.now() - started };
}

export function trimReply(reply, cap) {
  if (!reply) return reply;
  if (reply.length <= cap) return reply;
  const first = reply.split(/[.!?\n]/)[0].trim();
  if (first.length > 10 && first.length <= cap) return first;
  return reply.slice(0, cap);
}

// Ask the LLM for strict JSON and parse it robustly (strips code fences).
export async function completeJson(user, messages, gatewayOverride) {
  const model = user.model || (await getGateway()).llm_default_model || 'antigravity/gemini-2.5-flash';
  let lastErr = new Error('LLM did not return a JSON object');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await chatCompletion({ model, messages, maxTokens: 2500, ...gatewayOverride });
    const s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) {
      lastErr = new Error(s ? 'LLM did not return a JSON object' : 'LLM returned an empty response');
      continue;
    }
    try { return JSON.parse(s.slice(a, b + 1)); }
    catch (e) { lastErr = new Error(`LLM returned invalid JSON: ${e.message}`); }
  }
  throw lastErr;
}
