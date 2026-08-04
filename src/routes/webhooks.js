import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { webhookUrl } from '../services/bridge.js';
import { webhookBaseFor } from '../webhook-base.js';

const router = Router();
router.use(requireUser);

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
