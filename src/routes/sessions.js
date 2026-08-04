import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { discoverSessions, registerWebhooksForSession } from '../services/bridge.js';

const router = Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  try {
    if (!req.user.openwa_base_url || !req.user.openwa_api_key) {
      return res.status(400).json({ error: 'OpenWA is not connected — add your base URL and API key in Settings first', configMissing: true });
    }
    const discovered = await discoverSessions(req.user);
    res.json({ sessions: discovered });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const r = await query('SELECT * FROM wa_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ session: r.rows[0] });
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM wa_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    const characterId = req.body.character_id || null;
    if (characterId) {
      const c = await query('SELECT id FROM characters WHERE id=$1 AND user_id=$2', [characterId, req.user.id]);
      if (!c.rows.length) return res.status(400).json({ error: 'unknown character' });
    }
    const r = await query('UPDATE wa_sessions SET character_id=$1, updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING *',
      [characterId, req.params.id, req.user.id]);
    res.json({ session: r.rows[0] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const r = await query('DELETE FROM wa_sessions WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.get('/:id/messages', async (req, res) => {
  const chatId = req.query.chatId || '';
  const limit = Number(req.query.limit || 100);
  const r = await query(
    'SELECT * FROM messages WHERE user_id=$1 AND session_id=$2 AND ($3::text IS NULL OR chat_id=$3) ORDER BY created_at DESC LIMIT $4',
    [req.user.id, req.params.id, chatId || null, limit]
  );
  res.json({ messages: r.rows });
});

router.put('/:id/webhooks/register', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM wa_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    const urls = await registerWebhooksForSession(req.user, existing.rows[0], req.body.characterIds);
    res.json({ ok: true, urls });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
