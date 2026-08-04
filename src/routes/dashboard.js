import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { getLogs } from '../services/bridge.js';
import { buildMessageWhere, pageMeta, countQuery } from '../services/stats.js';

const router = Router();
router.use(requireUser);

router.get('/stats', async (req, res) => {
  const mw = buildMessageWhere({ ...req.query, userId: req.user.id });
  const { where, params } = mw;
  const totals = await query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE m.direction='incoming')::int AS incoming,
       count(*) FILTER (WHERE m.direction='outgoing')::int AS outgoing
     FROM messages m WHERE ${where}`,
    params
  );
  const chars = await query('SELECT count(*)::int AS n FROM characters WHERE user_id=$1', [req.user.id]);
  const sess = await query('SELECT count(*)::int AS n FROM wa_sessions WHERE user_id=$1', [req.user.id]);

  const perSession = await query(
    `SELECT s.id, s.openwa_session_id, s.name, s.phone, s.status, s.disconnected_at,
       coalesce(a.inbound,0)::int AS inbound, coalesce(a.outbound,0)::int AS outbound,
       a.last_activity,
       round((coalesce(a.outbound,0)::numeric / nullif(coalesce(a.inbound,0),0)) * 100, 1) AS reply_rate
     FROM wa_sessions s
     LEFT JOIN (
       SELECT m.session_id,
         count(*) FILTER (WHERE m.direction='incoming')::int AS inbound,
         count(*) FILTER (WHERE m.direction='outgoing')::int AS outbound,
         max(m.created_at) AS last_activity
       FROM messages m WHERE ${where} GROUP BY m.session_id
     ) a ON a.session_id = s.id
     WHERE s.user_id=$${params.length + 1}
     ORDER BY coalesce(a.last_activity, s.created_at) DESC
     LIMIT 50`,
    [...params, req.user.id]
  );

  const perCharacter = await query(
    `SELECT c.id, c.name, c.slug, c.active,
       coalesce(a.inbound,0)::int AS inbound, coalesce(a.outbound,0)::int AS outbound,
       a.last_activity,
       round((coalesce(a.outbound,0)::numeric / nullif(coalesce(a.inbound,0),0)) * 100, 1) AS reply_rate
     FROM characters c
     LEFT JOIN (
       SELECT m.character_id,
         count(*) FILTER (WHERE m.direction='incoming')::int AS inbound,
         count(*) FILTER (WHERE m.direction='outgoing')::int AS outbound,
         max(m.created_at) AS last_activity
       FROM messages m WHERE ${where} GROUP BY m.character_id
     ) a ON a.character_id = c.id
     WHERE c.user_id=$${params.length + 1}
     ORDER BY coalesce(a.last_activity, c.created_at) DESC`,
    [...params, req.user.id]
  );

  res.json({
    stats: {
      messages: totals.rows[0].total,
      incoming: totals.rows[0].incoming,
      outgoing: totals.rows[0].outgoing,
      characters: chars.rows[0].n,
      sessions: sess.rows[0].n,
      llmCalls: totals.rows[0].outgoing,
    },
    perSession: perSession.rows,
    perCharacter: perCharacter.rows,
    range: { from: params[0], to: params[1] },
  });
});

router.get('/logs', (req, res) => {
  res.json({ lines: getLogs(Number(req.query.lines || 80)) });
});

router.get('/messages', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(Number(req.query.perPage) || 25, 100);
  const mw = buildMessageWhere({ ...req.query, userId: req.user.id });
  const total = await countQuery(`SELECT m.id FROM messages m WHERE ${mw.where}`, mw.params, mw.params.length);
  const r = await query(
    `SELECT m.*, c.name AS character_name, s.name AS session_name
     FROM messages m
     LEFT JOIN characters c ON c.id=m.character_id
     LEFT JOIN wa_sessions s ON s.id=m.session_id
     WHERE ${mw.where} ORDER BY m.created_at DESC LIMIT $${mw.params.length + 1} OFFSET $${mw.params.length + 2}`,
    [...mw.params, perPage, (page - 1) * perPage]
  );
  res.json({ messages: r.rows, meta: pageMeta(total, page, perPage) });
});

export default router;
