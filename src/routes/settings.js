import { Router } from 'express';
import { query } from '../db.js';
import { requireUser, publicUser } from '../auth.js';

const router = Router();
router.use(requireUser);

const SETTINGS_FIELDS = ['openwa_base_url', 'openwa_api_key', 'model', 'fallback_model', 'memory_limit',
  'max_tokens', 'reply_hard_cap', 'default_character_id', 'webhooks_auto_register', 'typing', 'webhook_secret'];

router.get('/', (req, res) => {
  const u = publicUser(req.user);
  res.json({
    settings: {
      openwa_base_url: u.openwa_base_url,
      openwa_api_key: u.openwa_api_key,
      model: u.model,
      fallback_model: u.fallback_model,
      memory_limit: u.memory_limit,
      max_tokens: u.max_tokens,
      reply_hard_cap: u.reply_hard_cap,
      default_character_id: u.default_character_id,
      webhooks_auto_register: u.webhooks_auto_register,
      typing: u.typing,
      webhook_secret: u.webhook_secret,
    },
  });
});

router.put('/', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const f of SETTINGS_FIELDS) {
      if (b[f] !== undefined) patch[f] = b[f];
    }
    if (!Object.keys(patch).length) return res.json({ settings: publicUser(req.user) });
    const setClause = Object.keys(patch).map((k, i) => `${k}=$${i + 1}`).join(', ');
    const r = await query(`UPDATE users SET ${setClause}, updated_at=now() WHERE id=$${Object.keys(patch).length + 1} RETURNING *`,
      [...Object.values(patch), req.user.id]);
    res.json({ settings: publicUser(r.rows[0]) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
