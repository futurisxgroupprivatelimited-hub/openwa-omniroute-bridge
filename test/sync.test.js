import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMissedRows, syncWindow, isTooOldToReply } from '../src/services/bridge.js';

// ── filterMissedRows ──────────────────────────────────────────────
// Pure decision logic behind reconnect/periodic sync: given OpenWA history rows,
// return the inbound messages we have not already mirrored (dedup by remote_id,
// fallback to body when remote_id is absent).

const mk = (over = {}) => ({
  waMessageId: 'WA_1',
  body: 'hello',
  direction: 'incoming',
  createdAt: new Date('2026-08-04T10:00:00Z'),
  fromMe: false,
  ...over,
});

test('filterMissedRows: returns unseen incoming text messages', () => {
  const rows = [mk({ waMessageId: 'WA_1', body: 'first' }), mk({ waMessageId: 'WA_2', body: 'second' })];
  const missed = filterMissedRows(rows, {});
  assert.equal(missed.length, 2);
  assert.deepEqual(missed.map(m => [m.body, m.remote_id]), [['first', 'WA_1'], ['second', 'WA_2']]);
});

test('filterMissedRows: skips messages already mirrored by remote_id', () => {
  const rows = [mk({ waMessageId: 'WA_1' }), mk({ waMessageId: 'WA_2' })];
  const missed = filterMissedRows(rows, { knownRemoteIds: ['WA_1'] });
  assert.equal(missed.length, 1);
  assert.equal(missed[0].remote_id, 'WA_2');
});

test('filterMissedRows: skips outgoing/fromMe and empty bodies', () => {
  const rows = [
    mk({ waMessageId: 'OUT', direction: 'outgoing' }),
    mk({ waMessageId: 'ME', fromMe: true }),
    mk({ waMessageId: 'EMPTY', body: '   ' }),
    mk({ waMessageId: 'IN', body: 'kept' }),
  ];
  const missed = filterMissedRows(rows, {});
  assert.equal(missed.length, 1);
  assert.equal(missed[0].remote_id, 'IN');
});

test('filterMissedRows: respects the since window (older rows excluded)', () => {
  const since = new Date('2026-08-04T10:05:00Z');
  const rows = [
    mk({ waMessageId: 'OLD', createdAt: new Date('2026-08-04T09:00:00Z') }),
    mk({ waMessageId: 'NEW', createdAt: new Date('2026-08-04T10:10:00Z') }),
    mk({ waMessageId: 'NONE', createdAt: null }), // no timestamp -> kept
  ];
  const missed = filterMissedRows(rows, { since });
  assert.deepEqual(missed.map(m => m.remote_id), ['NEW', 'NONE']);
});

test('filterMissedRows: prefers waMessageId over row id/key for remote_id', () => {
  const row = mk({ waMessageId: 'WA_X', id: 'uuid-1', key: 'key-1' });
  const missed = filterMissedRows([row], {});
  assert.equal(missed[0].remote_id, 'WA_X');
});

test('filterMissedRows: falls back to id/key when waMessageId absent', () => {
  assert.equal(filterMissedRows([mk({ waMessageId: null, id: 'uuid-2' })], {})[0].remote_id, 'uuid-2');
  assert.equal(filterMissedRows([mk({ waMessageId: null, id: null, key: 'key-3' })], {})[0].remote_id, 'key-3');
});

test('filterMissedRows: dedups by body when remote_id is missing', () => {
  const rows = [
    mk({ waMessageId: null, body: 'repeat' }),
    mk({ waMessageId: null, body: 'repeat' }),
    mk({ waMessageId: null, body: 'other' }),
  ];
  const missed = filterMissedRows(rows, { seenBodies: ['repeat'] });
  assert.equal(missed.length, 1);
  assert.equal(missed[0].remote_id, null);
});

test('filterMissedRows: trimming and case-insensitive remote matching', () => {
  const rows = [mk({ waMessageId: 'WA_1', body: '  padded  ' })];
  const missed = filterMissedRows(rows, { knownRemoteIds: ['WA_1'] });
  assert.deepEqual(missed, []);
});

test('filterMissedRows: each result carries the source timestamp (ts)', () => {
  const at = new Date('2026-08-04T10:00:00Z');
  const missed = filterMissedRows([mk({ waMessageId: 'WA_1', createdAt: at })], {});
  assert.equal(missed[0].ts, at);
});

// ── syncWindow ────────────────────────────────────────────────────
test('syncWindow: explicit since wins', () => {
  const explicit = new Date('2026-08-04T08:00:00Z');
  const w = syncWindow({ last_synced_at: new Date('2026-08-04T11:00:00Z'), disconnected_at: new Date('2026-08-04T10:00:00Z') }, explicit);
  assert.equal(w.getTime(), explicit.getTime());
});

test('syncWindow: uses last_synced_at minus 5s buffer', () => {
  const w = syncWindow({ last_synced_at: new Date('2026-08-04T11:00:00Z') });
  assert.equal(w.getTime(), new Date('2026-08-04T11:00:00Z').getTime() - 5000);
});

test('syncWindow: falls back to disconnected_at minus 5s buffer', () => {
  const w = syncWindow({ disconnected_at: new Date('2026-08-04T10:00:00Z') });
  assert.equal(w.getTime(), new Date('2026-08-04T10:00:00Z').getTime() - 5000);
});

test('syncWindow: defaults to one hour ago', () => {
  const before = Date.now() - 60 * 60 * 1000 - 5000;
  const after = Date.now() - 60 * 60 * 1000 + 5000;
  const w = syncWindow({});
  assert.ok(w.getTime() >= before && w.getTime() <= after, `window ${w.toISOString()} not within 1h`);
});

// ── isTooOldToReply (ban-safety age gate) ────────────────────────
const NOW = new Date('2026-08-04T12:00:00Z').getTime();
const MAX_AGE = 48 * 60 * 60 * 1000;

test('isTooOldToReply: fresh message (within window) is replyable', () => {
  const fresh = { body: 'hi', ts: new Date(NOW - 1000) };
  assert.equal(isTooOldToReply(fresh, NOW, MAX_AGE), false);
});

test('isTooOldToReply: message older than the window is suppressed', () => {
  const old = { body: 'hi', ts: new Date(NOW - 49 * 60 * 60 * 1000) };
  assert.equal(isTooOldToReply(old, NOW, MAX_AGE), true);
});

test('isTooOldToReply: exactly at the window boundary is not suppressed', () => {
  assert.equal(isTooOldToReply({ ts: new Date(NOW - MAX_AGE) }, NOW, MAX_AGE), false);
});

test('isTooOldToReply: accepts raw ISO string and number timestamps', () => {
  assert.equal(isTooOldToReply({ ts: new Date(NOW - 1).toISOString() }, NOW, MAX_AGE), false);
  assert.equal(isTooOldToReply({ ts: NOW - 49 * 60 * 60 * 1000 }, NOW, MAX_AGE), true);
});

test('isTooOldToReply: missing/invalid timestamp is treated as fresh', () => {
  assert.equal(isTooOldToReply({ body: 'hi' }, NOW, MAX_AGE), false);
  assert.equal(isTooOldToReply({ ts: null }, NOW, MAX_AGE), false);
  assert.equal(isTooOldToReply({ ts: 'not-a-date' }, NOW, MAX_AGE), false);
  assert.equal(isTooOldToReply(null, NOW, MAX_AGE), false);
});
