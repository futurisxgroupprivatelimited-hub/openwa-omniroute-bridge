import { query } from '../db.js';

let cache = null;
let cachedAt = 0;
const TTL = 30000;

function seed() {
  return {
    llm_base_url: (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, ''),
    llm_bearer: process.env.OMNIROUTE_BEARER || 'omniroute',
    llm_default_model: process.env.DEFAULT_LLM_MODEL || 'big-pickle',
  };
}

async function load() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const r = await query('SELECT key, value FROM admin_settings');
    const row = {};
    for (const x of r.rows) row[x.key] = x.value;
    cache = { ...seed(), ...row };
    cachedAt = Date.now();
  } catch {
    cache = seed();
  }
  return cache;
}

export async function getGateway() {
  return load();
}

export function maskSecret(secret) {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return secret.slice(0, 4) + '••••••' + secret.slice(-4);
}

export async function setGateway({ llm_base_url, llm_bearer, llm_default_model }) {
  const patch = {};
  if (llm_base_url !== undefined) patch.llm_base_url = String(llm_base_url).trim().replace(/\/$/, '');
  if (llm_bearer !== undefined) patch.llm_bearer = String(llm_bearer);
  if (llm_default_model !== undefined) patch.llm_default_model = String(llm_default_model).trim();
  for (const [k, v] of Object.entries(patch)) {
    await query(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::text), now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [k, v]
    );
  }
  cache = null;
  return load();
}
