import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { webhookUrl } from '../services/bridge.js';
import { config } from '../config.js';

const router = Router();
router.use(requireUser);

// Webhook URLs must be reachable FROM the tenant's OpenWA instance. When WEBHOOK_BASE is
// explicitly set in the environment we honour it; otherwise we derive the base from the
// actual request the admin used to reach this dashboard (Host header) — which is far more
// likely to be a valid hostname/IP than a hardcoded localhost. OpenWA's SSRF guard only
// delivers to public hosts unless the target is allowlisted in its SSRF_ALLOWED_HOSTS.
function webhookBaseFor(req) {
  if (process.env.WEBHOOK_BASE) return config.webhookBase;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host = req.headers.host || req.headers['x-forwarded-host'] || `localhost:${config.port}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

router.get('/', async (req, res) => {
  const chars = await query('SELECT * FROM characters WHERE user_id=$1 AND active', [req.user.id]);
  const base = webhookBaseFor(req);
  res.json({
    base,
    token: req.user.webhook_token,
    generic: { path: `/webhook/${req.user.webhook_token}`, url: webhookUrl(req.user, null, base) },
    webhooks: chars.rows.map(c => ({
      characterId: c.id,
      characterName: c.name,
      slug: c.slug,
      path: `/webhook/${req.user.webhook_token}/${c.slug}`,
      url: webhookUrl(req.user, c, base),
    })),
  });
});

router.post('/regenerate', async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const r = await query('UPDATE users SET webhook_token=$1 WHERE id=$2 RETURNING *', [token, req.user.id]);
  res.json({ ok: true, token: r.rows[0].webhook_token });
});

export default router;
