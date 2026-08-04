import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load .env ourselves (node --test does not load dotenv).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {};
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

let url;
if (env.POSTGRES_PASSWORD) {
  // Prefer the real db credentials over a possibly-stale DATABASE_URL placeholder.
  url = `postgres://${env.POSTGRES_USER || 'openbridge'}:${env.POSTGRES_PASSWORD}@localhost:5432/${env.POSTGRES_DB || 'openbridge'}`;
} else {
  url = process.env.DATABASE_URL
    || env.DATABASE_URL
    || 'postgres://openbridge:openbridge@localhost:5432/openbridge';
  // When running tests on the host, the compose hostname `db` is not resolvable.
  if (/@db:/.test(url)) url = url.replace(/@db:/, '@localhost:');
}

let pool = null;
let dbOk = true;
let uid = null; // shared test user uuid
let notif = null; // lazily-imported app service (needs DATABASE_URL set first)
let countQuery = null;

before(async () => {
  process.env.DATABASE_URL = url; // must be set BEFORE src/db.js is imported
  notif = await import('../src/services/notifications.js');
  ({ countQuery } = await import('../src/services/stats.js'));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    await pool.query('SELECT 1');
    // idempotent schema safety (migrations may not have run in this env)
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL,
      password_hash text NOT NULL, name text NOT NULL DEFAULT '', plan text NOT NULL DEFAULT 'free',
      webhook_token text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24),'hex'), role text NOT NULL DEFAULT 'user',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      type text NOT NULL DEFAULT 'system', level text NOT NULL DEFAULT 'info',
      title text NOT NULL, body text NOT NULL DEFAULT '', session_id uuid,
      read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS characters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, slug text NOT NULL, tagline text NOT NULL DEFAULT '', greeting text NOT NULL DEFAULT '',
      bio text NOT NULL DEFAULT '', personality text NOT NULL DEFAULT '', reply_style text NOT NULL DEFAULT '',
      extra_rules text NOT NULL DEFAULT '', languages text[] NOT NULL DEFAULT ARRAY['English'],
      tags text[] NOT NULL DEFAULT '{}', visibility text NOT NULL DEFAULT 'private', active boolean NOT NULL DEFAULT true,
      example_messages jsonb NOT NULL DEFAULT '[]', typing_profile jsonb,
      knowledge_base text NOT NULL DEFAULT '', social_links jsonb NOT NULL DEFAULT '[]',
      drive_link text NOT NULL DEFAULT '', source_links jsonb NOT NULL DEFAULT '[]',
      sources_verified boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, slug))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      session_id uuid, chat_id text NOT NULL, direction text NOT NULL,
      body text NOT NULL, character_id uuid, remote_id text,
      created_at timestamptz NOT NULL DEFAULT now())`);
    // Mirror the production dedup index so persistMessage idempotency is exercised.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_test_messages_remote_dedup
      ON messages(user_id, remote_id) WHERE remote_id IS NOT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS playground_chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      character_id uuid, role text NOT NULL, content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    const r = await pool.query(`INSERT INTO users (email, password_hash, name)
      VALUES ($1,'x','integration-user') RETURNING id`, [`it-user-${Date.now()}@test.local`]);
    uid = r.rows[0].id;
  } catch (e) {
    dbOk = false;
    console.log('[db-integration] SKIPPING — postgres unreachable:', e.message);
  }
});

after(async () => { if (pool) { if (uid) await pool.query('DELETE FROM users WHERE id=$1', [uid]).catch(() => {}); await pool.end(); } });

const guard = (t) => { if (!dbOk || !uid) { t.skip('postgres unavailable'); return false; } return true; };

// ── notifications service ─────────────────────────────────────────
test('notifications: create + list + unread count + mark read flow', async (t) => {
  if (!guard(t)) return;
  const n = await notif.createNotification(uid, { type: 'health', level: 'warning', title: 'Session down', body: 'went offline', sessionId: null });
  assert.ok(n.id);
  assert.equal(n.read, false);
  assert.equal(n.level, 'warning');

  const list = await notif.listNotifications(uid, { limit: 50 });
  assert.ok(list.items.length >= 1);
  assert.ok(list.items[0].title === 'Session down');
  assert.equal((await notif.unreadCount(uid)) >= 1, true);

  await notif.markRead(uid, [n.id]);
  const afterRead = await notif.listNotifications(uid, { limit: 50 });
  assert.equal(afterRead.items.find(x => x.id === n.id).read, true);
  const cnt = await notif.unreadCount(uid);
  // our notification was the only one for this fresh user
  assert.equal(cnt, 0);
});

test('notifications: markRead with no ids marks all read', async (t) => {
  if (!guard(t)) return;
  await notif.createNotification(uid, { title: 'All' });
  await notif.createNotification(uid, { title: 'All2' });
  await notif.markRead(uid, null);
  const list = await notif.listNotifications(uid, { limit: 100 });
  assert.ok(list.items.every(x => x.read));
  assert.equal(await notif.unreadCount(uid), 0);
});

test('notifications: pagination returns total + pages', async (t) => {
  if (!guard(t)) return;
  for (let i = 0; i < 5; i++) await notif.createNotification(uid, { title: `pg-${i}` });
  const page2 = await notif.listNotifications(uid, { limit: 3, page: 2 });
  assert.equal(page2.perPage, 3);
  assert.equal(page2.page, 2);
  assert.ok(page2.pages >= 2);
  assert.equal(page2.items.length, 3);
});

test('notifications: notifyOwnerAndAdmins alerts the owner and every admin', async (t) => {
  if (!guard(t)) return;
  const admins = (await pool.query("SELECT id FROM users WHERE role='admin'")).rows.map(r => r.id);
  const created = await notif.notifyOwnerAndAdmins(uid, { type: 'llm_failed', level: 'error', title: 'AI reply failed', body: 'silent' });
  const targetIds = new Set(created.map(n => n.user_id));
  assert.ok(targetIds.has(uid), 'owner must be notified');
  for (const aid of admins) assert.ok(targetIds.has(aid), 'each admin must be notified');
  assert.ok(created.length >= 1);
  assert.ok(created.every(n => n.level === 'error'));
});

test('notifications: deleteNotifications clears rows (all or by ids)', async (t) => {
  if (!guard(t)) return;
  const a = await notif.createNotification(uid, { title: 'del-a' });
  const b = await notif.createNotification(uid, { title: 'del-b' });
  await notif.deleteNotifications(uid, [a.id]);
  const after = await notif.listNotifications(uid, { limit: 200 });
  assert.ok(!after.items.some(n => n.id === a.id));
  assert.ok(after.items.some(n => n.id === b.id));
  await notif.deleteNotifications(uid, null);
  const gone = await notif.listNotifications(uid, { limit: 200 });
  assert.equal(gone.items.some(n => n.id === b.id), false);
});

// ── countQuery (stats) ────────────────────────────────────────────
test('countQuery: counts rows of a wrapped SELECT', async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO messages (user_id, chat_id, direction, body) VALUES ($1,'c1','incoming','hi'), ($1,'c1','outgoing','hello'), ($1,'c2','incoming','yo')`,
    [uid]);
  const n = await countQuery('SELECT m.id FROM messages m WHERE m.user_id=$1', [uid], 1);
  assert.equal(n, 3);
});

// ── characters jsonb round-trip (the bind-mismatch regression) ───
test('characters: full jsonb insert + read round-trip', async (t) => {
  if (!guard(t)) return;
  const social = JSON.stringify([{ type: 'instagram', label: 'IG', url: 'https://ig.com/x' }]);
  const examples = JSON.stringify([{ role: 'user', content: 'who' }, { role: 'assistant', content: 'me' }]);
  const r = await pool.query(
    `INSERT INTO characters (user_id, name, slug, social_links, source_links, example_messages, languages, tags, knowledge_base, drive_link, sources_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [uid, 'It Char', 'it-char', social, '[]', examples, ['English'], ['test'], 'kb', 'https://drive.google.com/folders/x', true]);
  const c = r.rows[0];
  assert.deepEqual(c.social_links, JSON.parse(social));
  assert.deepEqual(c.example_messages, JSON.parse(examples));
  assert.deepEqual(c.languages, ['English']);
  assert.equal(c.sources_verified, true);
});

test('characters: update with dynamic SET clause has no bind mismatch', async (t) => {
  if (!guard(t)) return;
  const cid = (await pool.query(
    `INSERT INTO characters (user_id, name, slug) VALUES ($1,'Dyn','dyn') RETURNING id`, [uid])).rows[0].id;
  // mimic the PUT route: 17 fields -> placeholders $3..$19
  const patch = {
    name: 'Dyn', tagline: 't', greeting: 'g', bio: 'b', personality: 'p', reply_style: 'r',
    extra_rules: 'e', knowledge_base: 'kb', social_links: JSON.stringify([]), drive_link: '',
    example_messages: JSON.stringify([]), languages: ['English'], tags: [],
    visibility: 'private', active: true, sources_verified: false, slug: 'dyn',
  };
  const fields = Object.keys(patch);
  const setClause = fields.map((k, i) => `${k}=$${i + 3}`).join(', ');
  const up = await pool.query(
    `UPDATE characters SET ${setClause}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING tagline, example_messages, social_links`,
    [cid, uid, ...Object.values(patch)]);
  assert.equal(up.rows[0].tagline, 't');
  assert.deepEqual(up.rows[0].example_messages, []);
});

// ── playground chat history persistence ─────────────────────────
test('playground: thread persists in order and clears', async (t) => {
  if (!guard(t)) return;
  const cid = (await pool.query(
    `INSERT INTO characters (user_id, name, slug) VALUES ($1,'PG','pg') RETURNING id`, [uid])).rows[0].id;
  await pool.query(
    `INSERT INTO playground_chats (user_id, character_id, role, content) VALUES
     ($1,$2,'user','hello'), ($1,$2,'assistant','hi there'), ($1,$2,'user','again')`,
    [uid, cid]);
  const r = await pool.query(
    `SELECT role, content FROM playground_chats WHERE user_id=$1 AND character_id=$2 ORDER BY created_at ASC`,
    [uid, cid]);
  assert.deepEqual(r.rows.map(x => `${x.role}:${x.content}`), ['user:hello', 'assistant:hi there', 'user:again']);
  await pool.query(`DELETE FROM playground_chats WHERE user_id=$1 AND character_id=$2`, [uid, cid]);
  const after = await pool.query(
    `SELECT count(*)::int AS n FROM playground_chats WHERE user_id=$1 AND character_id=$2`, [uid, cid]);
  assert.equal(after.rows[0].n, 0);
});

test('playground: live chat threads aggregate messages per chat', async (t) => {
  if (!guard(t)) return;
  const cid = (await pool.query(
    `INSERT INTO characters (user_id, name, slug) VALUES ($1,'Live','live') RETURNING id`, [uid])).rows[0].id;
  await pool.query(
    `INSERT INTO messages (user_id, chat_id, direction, body, character_id, created_at) VALUES
     ($1,'977x@c.us','incoming','yo', $2, now() - interval '2 hours'),
     ($1,'977x@c.us','outgoing','hey', $2, now() - interval '1 hour'),
     ($1,'977x@c.us','incoming','again', $2, now()),
     ($1,'other@c.us','incoming','hi', $2, now())`,
    [uid, cid]);
  const agg = await pool.query(
    `SELECT chat_id, count(*)::int AS n, max(created_at) AS last_at FROM messages
     WHERE user_id=$1 AND character_id=$2 GROUP BY chat_id ORDER BY last_at DESC`,
    [uid, cid]);
  assert.equal(agg.rows.length, 2);
  const main = agg.rows.find(x => x.chat_id === '977x@c.us');
  assert.equal(main.n, 3);
  const full = await pool.query(
    `SELECT direction FROM messages WHERE user_id=$1 AND character_id=$2 AND chat_id=$3 ORDER BY created_at ASC`,
    [uid, cid, '977x@c.us']);
  assert.deepEqual(full.rows.map(r => r.direction), ['incoming', 'outgoing', 'incoming']);
});

// ── message mirroring idempotency (webhook + sync dedup) ─────────
test('persistMessage: same remote_id for the same user is stored exactly once', async (t) => {
  if (!guard(t)) return;
  const bridge = await import('../src/services/bridge.js');
  const chat = 'sync-test@c.us';
  await bridge.persistMessage(uid, null, chat, 'incoming', 'hello world', null, 'WA_DUP_1');
  await bridge.persistMessage(uid, null, chat, 'incoming', 'hello world', null, 'WA_DUP_1');
  await bridge.persistMessage(uid, null, chat, 'incoming', 'hello world', null, 'WA_DUP_1');
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE user_id=$1 AND remote_id=$2`, [uid, 'WA_DUP_1']);
  assert.equal(r.rows[0].n, 1);
});

test('persistMessage: two users may mirror the same WhatsApp remote_id', async (t) => {
  if (!guard(t)) return;
  const bridge = await import('../src/services/bridge.js');
  const other = (await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','sync-other') RETURNING id`,
    [`sync-other-${Date.now()}@test.local`])).rows[0].id;
  try {
    await bridge.persistMessage(uid, null, 'shared@c.us', 'incoming', 'shared msg', null, 'WA_SHARED');
    await bridge.persistMessage(other, null, 'shared@c.us', 'incoming', 'shared msg', null, 'WA_SHARED');
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE remote_id='WA_SHARED'`);
    assert.equal(r.rows[0].n, 2); // one per user — the per-user index must not block this
  } finally {
    await pool.query('DELETE FROM users WHERE id=$1', [other]);
  }
});

test('messages: wa_sessions.last_synced_at column exists (migration 007)', async (t) => {
  if (!guard(t)) return;
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name='wa_sessions' AND column_name='last_synced_at'`);
  assert.equal(r.rows[0].n, 1);
});
