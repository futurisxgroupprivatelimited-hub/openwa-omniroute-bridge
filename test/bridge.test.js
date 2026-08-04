import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnline, buildSystemPrompt, driveDirectUrl, splitMediaTokens, webhookUrl, typingSchedule, buildCharacterMessages, looksNonHuman, replyProblem } from '../src/services/bridge.js';

// ── isOnline ──────────────────────────────────────────────────────
test('isOnline: treats ready/active/connected (any case) as online', () => {
  assert.equal(isOnline('ready'), true);
  assert.equal(isOnline('READY'), true);
  assert.equal(isOnline('active'), true);
  assert.equal(isOnline('connected'), true);
});

test('isOnline: everything else is offline', () => {
  assert.equal(isOnline('disconnected'), false);
  assert.equal(isOnline('unknown'), false);
  assert.equal(isOnline(''), false);
  assert.equal(isOnline(undefined), false);
  assert.equal(isOnline(null), false);
});

// ── driveDirectUrl ────────────────────────────────────────────────
test('driveDirectUrl: converts /file/d/<id> share links to uc?export=download', () => {
  const out = driveDirectUrl('https://drive.google.com/file/d/AbC123xyz/view?usp=sharing');
  assert.equal(out, 'https://drive.google.com/uc?export=download&id=AbC123xyz');
});

test('driveDirectUrl: converts open?id=<id> links to direct download', () => {
  const out = driveDirectUrl('https://drive.google.com/open?id=xyz_123');
  assert.equal(out, 'https://drive.google.com/uc?export=download&id=xyz_123');
});

test('driveDirectUrl: non-drive links pass through unchanged (trimmed)', () => {
  assert.equal(driveDirectUrl('https://example.com/pic.jpg'), 'https://example.com/pic.jpg');
  assert.equal(driveDirectUrl('  https://example.com/x.png  '), 'https://example.com/x.png');
});

test('driveDirectUrl: empty input returns empty string', () => {
  assert.equal(driveDirectUrl(''), '');
  assert.equal(driveDirectUrl(undefined), '');
  assert.equal(driveDirectUrl(null), '');
});

// ── splitMediaTokens ──────────────────────────────────────────────
test('splitMediaTokens: extracts [IMG:url] tokens and strips them from text', () => {
  const { text, media } = splitMediaTokens('Here is your photo\n[IMG:https://a.com/1.jpg]');
  assert.deepEqual(media, ['https://a.com/1.jpg']);
  assert.ok(!text.includes('[IMG:'));
  assert.ok(text.includes('Here is your photo'));
});

test('splitMediaTokens: captures multiple tokens', () => {
  const { media } = splitMediaTokens('[IMG:a]\nb\n[IMG:b]');
  assert.deepEqual(media, ['a', 'b']);
});

test('splitMediaTokens: no tokens -> empty media, text unchanged', () => {
  const { text, media } = splitMediaTokens('plain reply');
  assert.deepEqual(media, []);
  assert.equal(text, 'plain reply');
});

test('splitMediaTokens: collapses 3+ newlines to 2', () => {
  const { text } = splitMediaTokens('a\n\n\n\n\nb');
  assert.equal(text, 'a\n\nb');
});

test('splitMediaTokens: empty reply yields empty result', () => {
  const { text, media } = splitMediaTokens('');
  assert.equal(text, '');
  assert.deepEqual(media, []);
});

// ── buildSystemPrompt ─────────────────────────────────────────────
test('buildSystemPrompt: returns default when no character', () => {
  assert.equal(buildSystemPrompt(null), 'You are a friendly WhatsApp assistant. Keep replies short.');
  assert.equal(buildSystemPrompt(undefined), 'You are a friendly WhatsApp assistant. Keep replies short.');
});

test('buildSystemPrompt: starts with identity + never-reveal-AI rule', () => {
  const p = buildSystemPrompt({ name: 'Rita' });
  assert.ok(p.includes('You are Rita'));
  assert.ok(p.includes('Never reveal that you are an AI'));
});

test('buildSystemPrompt: includes optional sections only when present', () => {
  const c = {
    name: 'Rita', bio: 'b', languages: ['English', 'Nepali'], personality: 'p', reply_style: 'r',
    extra_rules: 'e', knowledge_base: 'facts', social_links: [{ type: 'instagram', label: 'IG', url: 'https://ig.com/rita' }],
    drive_link: 'https://drive.google.com/drive/folders/f1', example_messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }],
  };
  const p = buildSystemPrompt(c);
  assert.ok(p.includes('BIO: b'));
  assert.ok(p.includes('LANGUAGES: Only reply in English or Nepali'));
  assert.ok(p.includes('PERSONALITY: p'));
  assert.ok(p.includes('REPLY STYLE: r'));
  assert.ok(p.includes('EXTRA RULES: e'));
  assert.ok(p.includes('VERIFIED KNOWLEDGE'));
  assert.ok(p.includes('facts'));
  assert.ok(p.includes('https://ig.com/rita'));
  assert.ok(p.includes('[IMG:https://drive.google.com/drive/folders/f1]'));
  assert.ok(p.includes('EXAMPLE CONVERSATION'));
  assert.ok(p.includes('Rita: a'));
});

test('buildSystemPrompt: drops malformed social links without url', () => {
  const p = buildSystemPrompt({ name: 'X', social_links: [{ type: 'website' }, { url: 'https://ok.com' }] });
  assert.ok(!p.includes('undefined'));
  assert.ok(p.includes('https://ok.com'));
});

test('buildSystemPrompt: multi-language join and example role mapping', () => {
  const p = buildSystemPrompt({ name: 'X', languages: ['EN', 'HI'], example_messages: [{ role: 'assistant', content: 'hi' }] });
  assert.ok(p.includes('Only reply in EN or HI'));
  assert.ok(p.includes('X: hi'));
});

// ── webhookUrl ────────────────────────────────────────────────────
test('webhookUrl: per-character webhook uses user token + slug', () => {
  const url = webhookUrl({ webhook_token: 'tok123' }, { slug: 'rita' });
  assert.ok(url.endsWith('/webhook/tok123/rita'));
});

test('webhookUrl: falls back to generic webhook when no character', () => {
  const url = webhookUrl({ webhook_token: 'tok123' }, null);
  assert.ok(url.endsWith('/webhook/tok123'));
});

// ── typingSchedule ────────────────────────────────────────────────
test('typingSchedule: returns [] when typing is disabled', () => {
  assert.deepEqual(typingSchedule({ enabled: false }, 50), []);
});

test('typingSchedule: always produces Reading, Thinking, Typing phases when enabled', () => {
  const phases = typingSchedule({ enabled: true, readDelayMs: [100, 200], falseStartChance: 0, minTypingMs: 100, maxTypingMs: 500 }, 40);
  assert.equal(phases.length, 3);
  assert.deepEqual(phases.map(p => p.label), ['Reading', 'Thinking', 'Typing']);
});

test('typingSchedule: read delay respects configured bounds', () => {
  for (let i = 0; i < 50; i++) {
    const phases = typingSchedule({ enabled: true, readDelayMs: [1000, 2000], falseStartChance: 0 }, 20);
    assert.ok(phases[0].ms >= 1000 && phases[0].ms <= 2000, `read ${phases[0].ms} outside [1000,2000]`);
  }
});

test('typingSchedule: typing time clamps to [minTypingMs, maxTypingMs]', () => {
  for (let i = 0; i < 50; i++) {
    const phases = typingSchedule({ enabled: true, falseStartChance: 0, minTypingMs: 500, maxTypingMs: 700 }, 5000);
    const typing = phases[phases.length - 1];
    assert.ok(typing.ms >= 500 && typing.ms <= 700, `typing ${typing.ms} outside [500,700]`);
  }
});

test('typingSchedule: may add a "Starting to type" false-start phase', () => {
  let saw = false;
  for (let i = 0; i < 200; i++) {
    const phases = typingSchedule({ enabled: true, falseStartChance: 1, readDelayMs: [1, 1], minTypingMs: 1, maxTypingMs: 1 }, 5);
    if (phases.some(p => p.label === 'Starting to type')) { saw = true; break; }
  }
  assert.equal(saw, true);
});

test('typingSchedule: falls back to defaults when typing is undefined', () => {
  const phases = typingSchedule(undefined, 50);
  assert.ok(phases.length >= 3);
  assert.equal(phases[0].label, 'Reading');
  assert.equal(phases[phases.length - 1].label, 'Typing');
});

// ── buildCharacterMessages (shared playground + webhook pipeline) ──
test('buildCharacterMessages: system prompt + history + user message', () => {
  const msgs = buildCharacterMessages({}, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'how are you?');
  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs.slice(1), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'how are you?' },
  ]);
});

test('buildCharacterMessages: ignores blank history entries and only slices last 12', () => {
  const hist = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const msgs = buildCharacterMessages({}, hist, 'last');
  const histMsgs = msgs.slice(1, -1);
  assert.equal(histMsgs.length, 12);
  assert.equal(histMsgs[0].content, 'm3');
});

test('buildCharacterMessages: maps any non-assistant history role to user', () => {
  const msgs = buildCharacterMessages({}, [{ role: 'system', content: 'x' }, { role: 'assistant', content: 'y' }], 'z');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
});

// ── looksNonHuman / replyProblem (never expose AI to real users) ──
test('looksNonHuman: normal human replies pass', () => {
  assert.equal(looksNonHuman('Hey! How are you doing?'), false);
  assert.equal(looksNonHuman('Sure, see you at 6pm tomorrow.'), false);
  assert.equal(looksNonHuman(''), false);
});

test('looksNonHuman: catches explicit AI self-identification', () => {
  assert.equal(looksNonHuman('As an AI, I cannot help with that.'), true);
  assert.equal(looksNonHuman('I am an AI language model.'), true);
  assert.equal(looksNonHuman("Sorry, I'm just an AI assistant."), true);
  assert.equal(looksNonHuman('I am ChatGPT, here to help.'), true);
});

test('looksNonHuman: catches quota / rate-limit / API errors', () => {
  assert.equal(looksNonHuman('Error 429: too many requests.'), true);
  assert.equal(looksNonHuman('Insufficient quota for this API key.'), true);
  assert.equal(looksNonHuman('Rate limit exceeded, try again later.'), true);
  assert.equal(looksNonHuman('401 invalid api key.'), true);
});

test('replyProblem: null / empty replies are flagged', () => {
  assert.equal(replyProblem(null), 'empty reply');
  assert.equal(replyProblem(''), 'empty reply');
  assert.equal(replyProblem('   \n '), 'empty reply');
});

test('replyProblem: AI/error text is flagged, clean text passes', () => {
  assert.equal(replyProblem('As an AI I cannot do that'), 'reply exposed AI/error content');
  assert.equal(replyProblem('Catch you later!'), null);
});
