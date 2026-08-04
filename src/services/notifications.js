import { query } from '../db.js';

export async function createNotification(userId, { type = 'system', level = 'info', title, body, sessionId = null }) {
  if (!userId || !title) return null;
  const r = await query(
    'INSERT INTO notifications (user_id, session_id, type, level, title, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [userId, sessionId, type, level, title, body || '']
  );
  return r.rows[0];
}

export async function listNotifications(userId, { limit = 30, page = 1, unreadOnly = false } = {}) {
  const where = ['user_id=$1'];
  const params = [userId];
  if (unreadOnly) { where.push('read=false'); }
  const w = where.join(' AND ');
  const total = (await query(`SELECT count(*)::int AS n FROM notifications WHERE ${w}`, params)).rows[0].n;
  const offset = (page - 1) * limit;
  const r = await query(
    `SELECT * FROM notifications WHERE ${w} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { items: r.rows, total, page, perPage: limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function unreadCount(userId) {
  const r = await query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read=false', [userId]);
  return r.rows[0].n;
}

export async function markRead(userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    await query('UPDATE notifications SET read=true WHERE user_id=$1 AND id = ANY($2::uuid[])', [userId, ids]);
  } else {
    await query('UPDATE notifications SET read=true WHERE user_id=$1 AND read=false', [userId]);
  }
  return { ok: true };
}
