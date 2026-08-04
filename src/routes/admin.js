import { Router } from 'express';
import { query } from '../db.js';
import { requireUser, requireAdmin, publicUser } from '../auth.js';
import { getGateway, setGateway, maskSecret } from '../services/gateway.js';
import { testLlmConfig } from '../services/omniroute.js';
import { buildMessageWhere, pageMeta, countQuery } from '../services/stats.js';

const router = Router();
router.use(requireUser, requireAdmin);

export function num(q, dflt, max) {
  const n = Number(q);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
}

// ── Global stats (filtered + paginated breakdowns) ───────────────
router.get('/stats', async (req, res) => {
  const filters = {
    range: req.query.range, from: req.query.from, to: req.query.to,
    userId: req.query.userId || null, sessionId: req.query.sessionId || null,
    characterId: req.query.characterId || null,
  };
  const { where, params } = buildMessageWhere(filters);
  const totals = await query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE m.direction='incoming')::int AS incoming,
       count(*) FILTER (WHERE m.direction='outgoing')::int AS outgoing
     FROM messages m WHERE ${where}`,
    params
  );

  const platform = await query(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM characters) AS characters,
       (SELECT count(*)::int FROM wa_sessions) AS sessions,
       (SELECT count(*)::int FROM users WHERE created_at >= $1) AS users_joined_range,
       (SELECT count(DISTINCT m.user_id)::int FROM messages m WHERE ${where}) AS active_users_range`,
    params
  );

  const perPage = 10;
  const up = num(req.query.upage, 1, 100000);
  const sp = num(req.query.spage, 1, 100000);
  const cp = num(req.query.cpage, 1, 100000);

  const userSql = `SELECT u.id, u.email, u.name, u.plan, u.role, u.created_at AS joined,
      coalesce(a.inbound,0)::int AS inbound, coalesce(a.outbound,0)::int AS outbound,
      coalesce(a.sessions_used,0)::int AS sessions_used, a.last_activity,
      (SELECT count(*)::int FROM characters c WHERE c.user_id=u.id) AS character_count,
      (SELECT count(*)::int FROM wa_sessions s WHERE s.user_id=u.id) AS session_count
    FROM users u
    LEFT JOIN (
      SELECT m.user_id,
        count(*) FILTER (WHERE m.direction='incoming')::int AS inbound,
        count(*) FILTER (WHERE m.direction='outgoing')::int AS outbound,
        count(DISTINCT m.session_id)::int AS sessions_used,
        max(m.created_at) AS last_activity
      FROM messages m WHERE ${where} GROUP BY m.user_id
    ) a ON a.user_id = u.id
    ORDER BY coalesce(a.last_activity, u.created_at) DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const usersTotal = (await query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const userRows = (await query(userSql, [...params, perPage, (up - 1) * perPage])).rows;

  const sessionSql = `SELECT s.id, s.openwa_session_id, s.name, s.phone, s.status, s.disconnected_at,
      u.email AS user_email, u.id AS user_id,
      coalesce(a.inbound,0)::int AS inbound, coalesce(a.outbound,0)::int AS outbound,
      a.last_activity,
      round((coalesce(a.outbound,0)::numeric / nullif(coalesce(a.inbound,0),0)) * 100, 1) AS reply_rate
    FROM wa_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN (
      SELECT m.session_id,
        count(*) FILTER (WHERE m.direction='incoming')::int AS inbound,
        count(*) FILTER (WHERE m.direction='outgoing')::int AS outbound,
        max(m.created_at) AS last_activity
      FROM messages m WHERE ${where} GROUP BY m.session_id
    ) a ON a.session_id = s.id
    ORDER BY coalesce(a.last_activity, s.created_at) DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const sessionRows = (await query(sessionSql, [...params, perPage, (sp - 1) * perPage])).rows;
  const sessionTotal = (await query(
    `SELECT count(DISTINCT m.session_id)::int AS n FROM messages m WHERE ${where}`, params)).rows[0].n;

  const charSql = `SELECT c.id, c.user_id, c.name, c.slug, c.active, u.email AS user_email,
      coalesce(a.inbound,0)::int AS inbound, coalesce(a.outbound,0)::int AS outbound,
      a.last_activity,
      round((coalesce(a.outbound,0)::numeric / nullif(coalesce(a.inbound,0),0)) * 100, 1) AS reply_rate
    FROM characters c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN (
      SELECT m.character_id,
        count(*) FILTER (WHERE m.direction='incoming')::int AS inbound,
        count(*) FILTER (WHERE m.direction='outgoing')::int AS outbound,
        max(m.created_at) AS last_activity
      FROM messages m WHERE ${where} GROUP BY m.character_id
    ) a ON a.character_id = c.id
    ORDER BY coalesce(a.last_activity, c.created_at) DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const charRows = (await query(charSql, [...params, perPage, (cp - 1) * perPage])).rows;
  const charTotal = (await query(
    `SELECT count(DISTINCT m.character_id)::int AS n FROM messages m WHERE ${where}`, params)).rows[0].n;

  res.json({
    range: { from: params[0], to: params[1] },
    totals: totals.rows[0],
    platform: platform.rows[0],
    perUser: { items: userRows, meta: pageMeta(usersTotal, up, perPage) },
    perSession: { items: sessionRows, meta: pageMeta(sessionTotal, sp, perPage) },
    perCharacter: { items: charRows, meta: pageMeta(charTotal, cp, perPage) },
  });
});

// ── Users list (search + pagination) ─────────────────────────────
router.get('/users', async (req, res) => {
  const page = num(req.query.page, 1, 100000);
  const perPage = num(req.query.perPage, 25, 100);
  const search = String(req.query.search || '').trim();
  const where = search ? '(email ILIKE $1 OR name ILIKE $1)' : '';
  const params = where ? [`%${search}%`] : [];
  const total = (await query(`SELECT count(*)::int AS n FROM users${where ? ' WHERE ' + where : ''}`, params)).rows[0].n;
  const r = await query(
    `SELECT u.id, u.email, u.name, u.plan, u.role, u.created_at, u.updated_at,
       (SELECT count(*)::int FROM characters c WHERE c.user_id=u.id) AS character_count,
       (SELECT count(*)::int FROM wa_sessions s WHERE s.user_id=u.id) AS session_count,
       (SELECT count(*)::int FROM messages m WHERE m.user_id=u.id) AS message_count,
       (SELECT count(*) FILTER (WHERE direction='incoming')::int FROM messages m WHERE m.user_id=u.id) AS inbound,
       (SELECT count(*) FILTER (WHERE direction='outgoing')::int FROM messages m WHERE m.user_id=u.id) AS outbound,
       (SELECT max(created_at) FROM messages m WHERE m.user_id=u.id) AS last_activity
     FROM users u${where ? ' WHERE ' + where : ''}
     ORDER BY last_activity DESC NULLS LAST
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, (page - 1) * perPage]
  );
  res.json({ users: r.rows, meta: pageMeta(total, page, perPage) });
});

// ── User detail ──────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  const u = await query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!u.rows.length) return res.status(404).json({ error: 'not found' });
  const user = u.rows[0];

  const chars = await query('SELECT * FROM characters WHERE user_id=$1 ORDER BY created_at', [user.id]);
  const sess = await query('SELECT * FROM wa_sessions WHERE user_id=$1 ORDER BY created_at', [user.id]);

  const msgPage = num(req.query.page, 1, 100000);
  const perPage = num(req.query.perPage, 20, 100);
  const mw = buildMessageWhere({ ...req.query, userId: user.id });
  const total = await countQuery(
    `SELECT m.id FROM messages m WHERE ${mw.where}`,
    mw.params, mw.params.length
  );
  const msgRows = (await query(
    `SELECT m.*, c.name AS character_name, s.name AS session_name
     FROM messages m
     LEFT JOIN characters c ON c.id=m.character_id
     LEFT JOIN wa_sessions s ON s.id=m.session_id
     WHERE ${mw.where} ORDER BY m.created_at DESC LIMIT $${mw.params.length + 1} OFFSET $${mw.params.length + 2}`,
    [...mw.params, perPage, (msgPage - 1) * perPage]
  )).rows;

  res.json({
    user: publicUser(user),
    characters: chars.rows,
    sessions: sess.rows,
    messages: { items: msgRows, meta: pageMeta(total, msgPage, perPage) },
  });
});

// ── LLM gateway config ───────────────────────────────────────────
router.get('/llm', async (req, res) => {
  const gw = await getGateway();
  res.json({
    llm_base_url: gw.llm_base_url,
    llm_bearer_masked: maskSecret(gw.llm_bearer),
    llm_bearer_set: Boolean(gw.llm_bearer),
    llm_default_model: gw.llm_default_model,
  });
});

router.put('/llm', async (req, res) => {
  try {
    const { llm_base_url, llm_bearer, llm_default_model } = req.body || {};
    const gw = await setGateway({ llm_base_url, llm_bearer, llm_default_model });
    res.json({
      llm_base_url: gw.llm_base_url,
      llm_bearer_masked: maskSecret(gw.llm_bearer),
      llm_default_model: gw.llm_default_model,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/llm/test', async (req, res) => {
  try {
    const { llm_base_url, llm_bearer, model } = req.body || {};
    res.json(await testLlmConfig({ llm_base_url, llm_bearer, model }));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
