import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { getLogs } from '../services/bridge.js';

const router = Router();
router.use(requireUser);

router.get('/stats', async (req, res) => {
  const [msgs, chars, sess, llm] = await Promise.all([
    query('SELECT count(*)::int AS n, count(*) FILTER (WHERE direction=\'incoming\')::int AS inb, count(*) FILTER (WHERE direction=\'outgoing\')::int AS out FROM messages WHERE user_id=$1', [req.user.id]),
    query('SELECT count(*)::int AS n FROM characters WHERE user_id=$1', [req.user.id]),
    query('SELECT count(*)::int AS n FROM wa_sessions WHERE user_id=$1', [req.user.id]),
    query('SELECT count(*)::int AS n FROM messages WHERE user_id=$1 AND direction=\'outgoing\'', [req.user.id]),
  ]);
  res.json({
    stats: {
      messages: msgs.rows[0].n,
      incoming: msgs.rows[0].inb,
      outgoing: msgs.rows[0].out,
      characters: chars.rows[0].n,
      sessions: sess.rows[0].n,
      llmCalls: llm.rows[0].n,
    },
  });
});

router.get('/logs', (req, res) => {
  res.json({ lines: getLogs(Number(req.query.lines || 80)) });
});

router.get('/messages', async (req, res) => {
  const chatId = req.query.chatId || '';
  const limit = Number(req.query.limit || 100);
  const r = await query(
    'SELECT * FROM messages WHERE user_id=$1 AND ($2::text IS NULL OR chat_id=$2) ORDER BY created_at DESC LIMIT $3',
    [req.user.id, chatId || null, limit]
  );
  res.json({ messages: r.rows });
});

export default router;
