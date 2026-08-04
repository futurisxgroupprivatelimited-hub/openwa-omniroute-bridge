import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { buildCharacterMessages, typingSchedule, sleep, splitMediaTokens, driveDirectUrl } from '../services/bridge.js';
import { askModel } from '../services/omniroute.js';
import { getGateway } from '../services/gateway.js';

const router = Router();
router.use(requireUser);

// GET /api/playground/history/:characterId — full stored playground thread
router.get('/history/:characterId', async (req, res) => {
  try {
    const r = await query(
      `SELECT role, content, created_at FROM playground_chats
       WHERE user_id=$1 AND character_id=$2 ORDER BY created_at ASC`,
      [req.user.id, req.params.characterId]
    );
    res.json({ messages: r.rows.map(m => ({ role: m.role, content: m.content, at: m.created_at })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/playground/history/:characterId — clear the stored thread
router.delete('/history/:characterId', async (req, res) => {
  try {
    await query(
      'DELETE FROM playground_chats WHERE user_id=$1 AND character_id=$2',
      [req.user.id, req.params.characterId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/playground/live/:characterId — real WhatsApp conversations for a character
router.get('/live/:characterId', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.chat_id, m.session_id, s.name AS session_name, m.n, m.last_at, x.body AS last_body
       FROM (
         SELECT m.chat_id, m.session_id, count(*)::int AS n, max(m.created_at) AS last_at
         FROM messages m
         WHERE m.user_id=$1 AND m.character_id=$2
         GROUP BY m.chat_id, m.session_id
       ) m
       LEFT JOIN LATERAL (
         SELECT body FROM messages m2
         WHERE m2.user_id=$1 AND m2.chat_id=m.chat_id
         ORDER BY m2.created_at DESC LIMIT 1
       ) x ON true
       LEFT JOIN wa_sessions s ON s.id = m.session_id
       ORDER BY m.last_at DESC`,
      [req.user.id, req.params.characterId]
    );
    res.json({ chats: r.rows.map(c => ({
      chatId: c.chat_id,
      sessionId: c.session_id,
      sessionName: c.session_name,
      n: c.n,
      lastAt: c.last_at,
      lastBody: c.last_body,
    })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/playground/live/:characterId/:chatId — full real conversation
router.get('/live/:characterId/:chatId', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.direction, m.body, m.created_at, m.session_id, s.name AS session_name
       FROM messages m
       LEFT JOIN wa_sessions s ON s.id = m.session_id
       WHERE m.user_id=$1 AND m.character_id=$2 AND m.chat_id=$3
       ORDER BY m.created_at ASC`,
      [req.user.id, req.params.characterId, req.params.chatId]
    );
    res.json({
      chatId: req.params.chatId,
      messages: r.rows.map(m => ({
        role: m.direction === 'incoming' ? 'user' : 'assistant',
        content: m.body,
        at: m.created_at,
        session: m.session_name,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/playground — send a test message (persisted into the character's thread)
router.post('/', async (req, res) => {
  try {
    const { characterId, message, history } = req.body || {};
    const text = String(message || '').trim();
    if (!characterId) return res.status(400).json({ error: 'characterId required' });
    if (!text) return res.status(400).json({ error: 'message required' });

    const c = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [characterId, req.user.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'character not found' });

    // Memory mirrors the real webhook: the character's stored thread (last N)
    // plus any explicit context typed into the playground, then the new message.
    const stored = await query(
      `SELECT role, content FROM playground_chats
       WHERE user_id=$1 AND character_id=$2
       ORDER BY created_at DESC LIMIT $3`,
      [req.user.id, characterId, req.user.memory_limit || 40]
    );
    const thread = stored.rows.reverse().map(r => ({ role: r.role, content: r.content }));
    const context = Array.isArray(history) ? history : [];
    const msgs = buildCharacterMessages(c.rows[0], [...thread, ...context], text);

    const started = Date.now();
    const reply = await askModel(req.user, msgs);
    const gw = await getGateway();

    // Simulate human reading + typing before the reply lands (respects tenant settings).
    const phases = typingSchedule(req.user.typing, (reply || '').length);
    for (const p of phases) await sleep(p.ms);
    const typingMs = phases.reduce((a, p) => a + p.ms, 0);

    // Exactly like the real bridge: strip media tokens, resolve Drive URLs.
    const { text: replyText, media } = splitMediaTokens(reply);

    await query(
      `INSERT INTO playground_chats (user_id, character_id, role, content) VALUES
       ($1,$2,'user',$3), ($1,$2,'assistant',$4)`,
      [req.user.id, characterId, text, replyText || '']
    );
    await query('UPDATE characters SET last_active_at=now() WHERE id=$1', [characterId]);

    res.json({
      reply: replyText,
      media: media.slice(0, 2).map(driveDirectUrl),
      model: req.user.model || gw.llm_default_model || 'big-pickle',
      latencyMs: Date.now() - started,
      typingMs,
      typingPhases: phases,
      character: { id: c.rows[0].id, name: c.rows[0].name, slug: c.rows[0].slug },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
