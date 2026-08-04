import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signToken, publicUser, requireAdmin } from '../src/auth.js';
import { config } from '../src/config.js';

// ── signToken ─────────────────────────────────────────────────────
test('signToken: produces a JWT that verifies with the app secret and carries the user id', () => {
  const token = signToken({ id: 'abc-123', email: 'a@b.c' });
  const decoded = jwt.verify(token, config.jwtSecret);
  assert.equal(decoded.sub, 'abc-123');
  assert.equal(decoded.email, 'a@b.c');
});

test('signToken: tokens have an expiry claim', () => {
  const token = signToken({ id: 'x', email: 'e' });
  const decoded = jwt.decode(token);
  assert.ok(typeof decoded.exp === 'number');
  assert.ok(decoded.exp > Date.now() / 1000);
});

test('signToken: distinct users produce distinct tokens', () => {
  const t1 = signToken({ id: 'a', email: 'a' });
  const t2 = signToken({ id: 'b', email: 'b' });
  assert.notEqual(t1, t2);
});

// ── publicUser ────────────────────────────────────────────────────
test('publicUser: maps only whitelisted fields (no password_hash)', () => {
  const u = {
    id: 'id1', email: 'e@x.y', name: 'N', plan: 'pro', role: 'admin', api_key: 'k',
    webhook_token: 'wt', webhook_secret: 'ws', openwa_base_url: 'http://owa', openwa_api_key: 'oka',
    model: 'm', fallback_model: 'f', memory_limit: 40, max_tokens: 80, reply_hard_cap: 120,
    default_character_id: 'd', webhooks_auto_register: true, typing: {}, created_at: new Date(),
    password_hash: 'SHOULD-NOT-LEAK', __internal: true,
  };
  const out = publicUser(u);
  assert.equal(out.email, 'e@x.y');
  assert.equal(out.password_hash, undefined);
  assert.equal(out.__internal, undefined);
  assert.equal(out.role, 'admin');
});

test('publicUser: defaults role to "user" when absent', () => {
  const out = publicUser({ id: 'i', email: 'e', webhook_token: 'w' });
  assert.equal(out.role, 'user');
});

// ── requireAdmin (pure middleware, no DB) ─────────────────────────
test('requireAdmin: lets admins through', async () => {
  let nextCalled = false;
  const req = { user: { role: 'admin' } };
  const res = { status: () => res, json: () => res };
  await requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireAdmin: blocks non-admins with 403', async () => {
  let nextCalled = false;
  let statusCode = null;
  const req = { user: { role: 'user' } };
  const res = { status: (c) => { statusCode = c; return res; }, json: () => res };
  await requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
});

test('requireAdmin: blocks when no user present', async () => {
  let nextCalled = false;
  let statusCode = null;
  const res = { status: (c) => { statusCode = c; return res; }, json: () => res };
  await requireAdmin({ user: null }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
});
