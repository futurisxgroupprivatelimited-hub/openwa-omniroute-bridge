import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://openbridge:openbridge@localhost:5432/openbridge';
const client = new pg.Client({ connectionString: DATABASE_URL });

async function run() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }

  await bootstrapAdmin();
  await client.end();
  console.log('[migrate] done');
}

async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@openbridge.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  const exists = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows.length) {
    await client.query('UPDATE users SET role=$1 WHERE email=$2', ['admin', email]);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await client.query(
    'INSERT INTO users (email, password_hash, name, plan, role, api_key) VALUES ($1, $2, $3, $4, $5, $6)',
    [email, hash, 'Admin', 'pro', 'admin', 'owa_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)]
  );

  await client.query(
    `INSERT INTO admin_settings (key, value) VALUES
      ('llm_base_url',  to_jsonb($1::text)),
      ('llm_bearer',    to_jsonb($2::text)),
      ('llm_default_model', to_jsonb($3::text))
     ON CONFLICT (key) DO NOTHING`,
    [process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128',
     process.env.OMNIROUTE_BEARER || 'omniroute',
     process.env.DEFAULT_LLM_MODEL || 'big-pickle']
  );
  console.log(`[migrate] bootstrap admin created: ${email}`);
}

run().catch(e => {
  console.error('[migrate] failed:', e.message);
  process.exit(1);
});
