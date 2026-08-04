import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, asArray, normalizeCharacter, jsonb } from '../src/routes/characters.js';

// ── slugify ───────────────────────────────────────────────────────
test('slugify: lowercases and replaces non-alphanumeric runs with a dash', () => {
  assert.equal(slugify('Sushmita Sen'), 'sushmita-sen');
  assert.equal(slugify('Hello, World! 2024'), 'hello-world-2024');
});

test('slugify: trims leading/trailing dashes', () => {
  assert.equal(slugify('--name--'), 'name');
  assert.equal(slugify('  spaced  '), 'spaced');
});

test('slugify: falls back to "char" for empty input', () => {
  assert.equal(slugify(''), 'char');
  assert.equal(slugify(undefined), 'char');
  assert.equal(slugify(null), 'char');
});

test('slugify: keeps digits and handles mixed content', () => {
  assert.equal(slugify('Ri&#39;ta'), 'ri-39-ta'); // '#' and "'" -> dashes, digits kept
  assert.equal(slugify('Café 42'), 'caf-42');
});

// ── asArray ───────────────────────────────────────────────────────
test('asArray: passes arrays through unchanged', () => {
  const a = [{ x: 1 }];
  assert.equal(asArray(a), a);
});

test('asArray: coerces non-arrays to empty array', () => {
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray('nope'), []);
  assert.deepEqual(asArray({ a: 1 }), []);
});

// ── jsonb ─────────────────────────────────────────────────────────
test('jsonb: string values pass through untouched', () => {
  assert.equal(jsonb('[1,2]'), '[1,2]');
});

test('jsonb: arrays and objects are JSON-encoded', () => {
  assert.equal(jsonb([{ role: 'user', content: 'hi' }]), '[{"role":"user","content":"hi"}]');
  assert.equal(jsonb({ enabled: true }), '{"enabled":true}');
});

test('jsonb: null/undefined become JSON null', () => {
  assert.equal(jsonb(null), 'null');
  assert.equal(jsonb(undefined), 'null');
});

// ── normalizeCharacter ────────────────────────────────────────────
test('normalizeCharacter: null passthrough', () => {
  assert.equal(normalizeCharacter(null), null);
  assert.equal(normalizeCharacter(undefined), undefined);
});

test('normalizeCharacter: coerces legacy object-shaped jsonb arrays to arrays (the edit bug)', () => {
  const c = normalizeCharacter({
    name: 'R', example_messages: { 0: { role: 'user', content: 'a' } }, social_links: 'not-array',
    source_links: null, languages: null, tags: 'x',
  });
  assert.ok(Array.isArray(c.example_messages));
  assert.ok(Array.isArray(c.social_links));
  assert.ok(Array.isArray(c.source_links));
  assert.ok(Array.isArray(c.languages));
  assert.ok(Array.isArray(c.tags));
});

test('normalizeCharacter: keeps well-formed arrays untouched (same reference)', () => {
  const arr = [{ role: 'user', content: 'x' }];
  const c = normalizeCharacter({ name: 'R', example_messages: arr });
  assert.equal(c.example_messages, arr);
});
