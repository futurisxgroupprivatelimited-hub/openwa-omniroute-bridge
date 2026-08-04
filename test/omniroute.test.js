import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trimReply, chatCompletion, askModel, completeJson, testLlmConfig } from '../src/services/omniroute.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeFetch(body, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
}

// ── trimReply ─────────────────────────────────────────────────────
test('trimReply: returns reply as-is when within cap', () => {
  assert.equal(trimReply('short', 120), 'short');
});

test('trimReply: cuts long reply at first sentence when sentence fits the cap', () => {
  const long = 'This is a long first sentence that definitely exceeds the cap. And then more trailing text.';
  const out = trimReply(long, 65);
  assert.equal(out, 'This is a long first sentence that definitely exceeds the cap');
  assert.ok(out.length < long.length);
});

test('trimReply: hard-caps at `cap` when the first sentence itself is longer than the cap', () => {
  const long = 'This is a long first sentence that definitely exceeds the cap. And more.';
  const out = trimReply(long, 10);
  assert.equal(out, 'This is a '); // exactly 10 chars
  assert.equal(out.length, 10);
});

test('trimReply: caps mid-word when first sentence is too short', () => {
  const long = 'Hi. ' + 'x'.repeat(200);
  const out = trimReply(long, 10);
  assert.ok(out.length <= 10);
});

test('trimReply: handles empty and missing input', () => {
  assert.equal(trimReply('', 120), '');
  assert.equal(trimReply(null, 120), null);
  assert.equal(trimReply(undefined, 120), undefined);
});

// ── chatCompletion (mock fetch) ───────────────────────────────────
test('chatCompletion: returns message content trimmed', async () => {
  fakeFetch({ choices: [{ message: { content: '  Hello World  ' } }] });
  const out = await chatCompletion({ model: 'm', messages: [], maxTokens: 80, base: 'http://llm', bearer: 'k' });
  assert.equal(out, 'Hello World');
});

test('chatCompletion: throws on non-2xx with status in message', async () => {
  fakeFetch({ error: 'x' }, 500);
  await assert.rejects(() => chatCompletion({ model: 'm', messages: [], base: 'http://llm', bearer: 'k' }), /LLM 500/);
});

test('chatCompletion: returns empty string when choices missing', async () => {
  fakeFetch({});
  const out = await chatCompletion({ model: 'm', messages: [], base: 'http://llm', bearer: 'k' });
  assert.equal(out, '');
});

// ── askModel (mock fetch) ─────────────────────────────────────────
test('askModel: uses primary model and trims to hard cap', async () => {
  let called = [];
  globalThis.fetch = async (_u, opts) => {
    called.push(JSON.parse(opts.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'R'.repeat(500) } }] }), { status: 200 });
  };
  const user = { model: 'primary', fallback_model: 'fallback', max_tokens: 80, reply_hard_cap: 120 };
  const out = await askModel(user, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(called, ['primary']);
  assert.ok(out.length <= 120);
});

test('askModel: falls back to fallback_model when primary errors', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return new Response('x', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback reply' } }] }), { status: 200 });
  };
  const user = { model: 'primary', fallback_model: 'fallback', max_tokens: 80, reply_hard_cap: 120 };
  const out = await askModel(user, []);
  assert.equal(out, 'fallback reply');
});

test('askModel: rethrows when no fallback available', async () => {
  globalThis.fetch = async () => new Response('x', { status: 500 });
  const user = { model: 'primary', fallback_model: 'auto' }; // fallback === model branch skips fallback
  await assert.rejects(() => askModel(user, []));
});

// ── completeJson (mock fetch) ─────────────────────────────────────
test('completeJson: parses bare JSON response', async () => {
  fakeFetch({ choices: [{ message: { content: '{"name":"Rita"}' } }] });
  const out = await completeJson({ model: 'm' }, []);
  assert.deepEqual(out, { name: 'Rita' });
});

test('completeJson: strips markdown fences before parsing', async () => {
  fakeFetch({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] });
  const out = await completeJson({ model: 'm' }, []);
  assert.deepEqual(out, { a: 1 });
});

test('completeJson: extracts JSON embedded in prose', async () => {
  fakeFetch({ choices: [{ message: { content: 'Sure, here: {"a":1,"b":[1,2]} that is it.' } }] });
  const out = await completeJson({ model: 'm' }, []);
  assert.deepEqual(out, { a: 1, b: [1, 2] });
});

test('completeJson: retries up to 3 times on empty responses', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    const content = n === 3 ? '{"ok":true}' : '';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const out = await completeJson({ model: 'm' }, []);
  assert.deepEqual(out, { ok: true });
  assert.equal(n, 3);
});

test('completeJson: throws after 3 non-JSON attempts', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 });
  };
  await assert.rejects(() => completeJson({ model: 'm' }, []), /did not return a JSON object/);
  assert.equal(n, 3);
});

test('completeJson: throws on invalid JSON after stripping', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"broken": }' } }] }), { status: 200 });
  await assert.rejects(() => completeJson({ model: 'm' }, []), /invalid JSON/);
});

// ── testLlmConfig (new-gateway smoke test, mock fetch) ────────────
test('testLlmConfig: returns ok with reply + latency on success', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  const out = await testLlmConfig({ llm_base_url: 'http://llm', llm_bearer: 'k', model: 'm' });
  assert.equal(out.ok, true);
  assert.equal(out.reply, 'OK');
  assert.equal(typeof out.latencyMs, 'number');
});

test('testLlmConfig: hits the supplied base URL with the supplied model + bearer', async () => {
  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };
  await testLlmConfig({ llm_base_url: 'http://custom:9999/', llm_bearer: 'sk-test', model: 'gpt-test' });
  assert.equal(seen.url, 'http://custom:9999/v1/chat/completions');
  assert.equal(seen.body.model, 'gpt-test');
  assert.equal(seen.auth, 'Bearer sk-test');
});

test('testLlmConfig: fails cleanly when the endpoint errors', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 502 });
  await assert.rejects(() => testLlmConfig({ llm_base_url: 'http://llm', llm_bearer: 'k', model: 'm' }), /LLM 502/);
});

test('testLlmConfig: defaults model to big-pickle when omitted', async () => {
  let body = null;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };
  await testLlmConfig({ llm_base_url: 'http://llm', llm_bearer: 'k' });
  assert.equal(body.model, 'big-pickle');
});
