import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from './db.js';
import { handleInboundMessage, logLine } from './services/bridge.js';

const router = Router();
const dedupe = new Map();
const MAX_BODY = 2 * 1024 * 1024;

function verifyHmac(secret, rawBody, signatureHeader) {
  if (!secret || !signatureHeader) return true; // HMAC optional per tenant
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isDuplicate(key) {
  if (!key) return false;
  if (dedupe.has(key)) return true;
  dedupe.set(key, Date.now());
  setTimeout(() => dedupe.delete(key), 300000);
  return false;
}

router.post('/webhook/:token', handle);
router.post('/webhook/:token/:slug', handle);

async function handle(req, res) {
  const { token, slug } = req.params;
  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    return res.status(400).json({ error: 'bad body' });
  }

  try {
    const u = await query('SELECT * FROM users WHERE webhook_token=$1', [token]);
    if (!u.rows.length) {
      await logLine(`[webhook] unknown token ${token.slice(0, 6)}…`);
      return res.status(404).json({ error: 'unknown webhook' });
    }
    const user = u.rows[0];

    if (!verifyHmac(user.webhook_secret, raw, req.headers['x-openwa-signature'])) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const idem = req.headers['x-openwa-idempotency-key'];
    if (isDuplicate(idem)) return res.json({ status: 'duplicate' });

    const event = JSON.parse(raw.toString('utf8'));
    handleInboundMessage(user, event, slug || null).catch(async e => {
      await logLine(`[handle] ${user.email} failed: ${e.message}`);
    });

    res.json({ status: 'received', character: slug || 'generic' });
  } catch (e) {
    await logLine(`[webhook] error: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default router;
