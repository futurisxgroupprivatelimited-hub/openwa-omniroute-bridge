import { query } from '../db.js';

let cache = null;
let cachedAt = 0;
const TTL = 30000;

function seed() {
  return {
    id: null,
    llm_base_url: (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, ''),
    llm_bearer: process.env.OMNIROUTE_BEARER || 'omniroute',
    llm_default_model: process.env.DEFAULT_LLM_MODEL || 'big-pickle',
  };
}

async function load() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const r = await query('SELECT id, base_url, bearer_token, model FROM llm_endpoints WHERE is_active = true LIMIT 1');
    if (r.rows.length) {
      cache = {
        id: r.rows[0].id,
        llm_base_url: r.rows[0].base_url,
        llm_bearer: r.rows[0].bearer_token || '',
        llm_default_model: r.rows[0].model,
      };
    } else {
      const rr = await query('SELECT key, value FROM admin_settings');
      const row = {};
      for (const x of rr.rows) row[x.key] = x.value;
      cache = { ...seed(), ...row };
    }
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

export function clearGatewayCache() {
  cache = null;
  cachedAt = 0;
}
