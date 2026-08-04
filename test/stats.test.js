import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeToDates, buildMessageWhere, pageMeta, splitNums } from '../src/services/stats.js';

// ── rangeToDates ──────────────────────────────────────────────────
test('rangeToDates: named ranges (7d/30d/90d/24h) produce expected window', () => {
  const end = new Date('2026-08-04T12:00:00Z');
  const d7 = rangeToDates('7d', null, end.toISOString());
  assert.equal(d7.end.getTime(), end.getTime());
  assert.equal(d7.start.getTime(), end.getTime() - 7 * 24 * 3600 * 1000);
});

test('rangeToDates: 30d window', () => {
  const end = new Date('2026-08-04T12:00:00Z');
  const d = rangeToDates('30d', null, end.toISOString());
  assert.equal(d.start.getTime(), end.getTime() - 30 * 24 * 3600 * 1000);
});

test('rangeToDates: "all" (or missing range) means the beginning of time (epoch 0)', () => {
  const end = new Date('2026-08-04T12:00:00Z');
  assert.equal(rangeToDates('all', null, end.toISOString()).start.getTime(), 0);
  assert.equal(rangeToDates(undefined, null, end.toISOString()).start.getTime(), 0);
  assert.equal(rangeToDates(null, null, end.toISOString()).start.getTime(), 0);
});

test('rangeToDates: explicit from/to is respected and wins over range', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-02-01T00:00:00Z');
  const d = rangeToDates('7d', from.toISOString(), to.toISOString());
  assert.equal(d.start.getTime(), from.getTime());
  assert.equal(d.end.getTime(), to.getTime());
});

test('rangeToDates: unknown range name falls back to 0 days (start == end)', () => {
  const end = new Date('2026-08-04T12:00:00Z');
  const d = rangeToDates('bogus', null, end.toISOString());
  assert.equal(d.start.getTime(), end.getTime());
});

test('rangeToDates: no `to` uses now() (end is a valid date close to now)', () => {
  const before = Date.now();
  const d = rangeToDates('30d');
  assert.ok(d.end.getTime() >= before - 2000 && d.end.getTime() <= before + 5000);
  assert.equal(d.start.getTime(), d.end.getTime() - 30 * 24 * 3600 * 1000);
});

// ── buildMessageWhere ─────────────────────────────────────────────
test('buildMessageWhere: always includes a created_at range bound', () => {
  const { where, params } = buildMessageWhere({ range: '30d' });
  assert.ok(where.includes('m.created_at >='));
  assert.ok(where.includes('m.created_at <'));
  assert.equal(params.length, 2);
  assert.ok(params[0] instanceof Date && params[1] instanceof Date);
});

test('buildMessageWhere: placeholders are sequential with the given params', () => {
  const { where, params } = buildMessageWhere({ userId: 'u1', sessionId: 's1', characterId: 'c1', direction: 'incoming', chatId: 'x', range: 'all' });
  // 2 range + 5 filters = 7 params, placeholders $1..$7
  assert.equal(params.length, 7);
  for (let i = 1; i <= 7; i++) assert.ok(where.includes(`$${i}`), `expected $${i} in where`);
  assert.equal(params[2], 'u1');
  assert.equal(params[3], 's1');
  assert.equal(params[4], 'c1');
  assert.equal(params[5], 'incoming');
  assert.equal(params[6], 'x');
});

test('buildMessageWhere: unknown/blank filters are ignored', () => {
  const { where, params } = buildMessageWhere({ range: 'all', userId: '', sessionId: undefined, characterId: null });
  assert.equal(params.length, 2);
  assert.ok(!where.includes('user_id'));
});

test('buildMessageWhere: "all" range yields epoch start param', () => {
  const { params } = buildMessageWhere({ range: 'all' });
  assert.equal(params[0].getTime(), 0);
});

// ── pageMeta ──────────────────────────────────────────────────────
test('pageMeta: computes pages and clamps minimum to 1', () => {
  assert.deepEqual(pageMeta(100, 1, 25), { total: 100, page: 1, perPage: 25, pages: 4 });
  assert.deepEqual(pageMeta(0, 1, 25), { total: 0, page: 1, perPage: 25, pages: 1 });
  assert.deepEqual(pageMeta(24, 2, 25), { total: 24, page: 2, perPage: 25, pages: 1 });
});

test('pageMeta: ceil of partial pages', () => {
  assert.equal(pageMeta(26, 1, 25).pages, 2);
  assert.equal(pageMeta(25, 1, 25).pages, 1);
  assert.equal(pageMeta(1, 1, 100).pages, 1);
});

// ── splitNums ─────────────────────────────────────────────────────
test('splitNums: splits comma lists, trims, drops empties', () => {
  assert.deepEqual(splitNums('a,b, c ,,d'), ['a', 'b', 'c', 'd']);
});

test('splitNums: handles empty / non-string input', () => {
  assert.deepEqual(splitNums(''), []);
  assert.deepEqual(splitNums(undefined), []);
  assert.deepEqual(splitNums(null), []);
});

test('splitNums: single value without comma', () => {
  assert.deepEqual(splitNums('only'), ['only']);
});
