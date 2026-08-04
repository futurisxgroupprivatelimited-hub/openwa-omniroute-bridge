import { query } from '../db.js';

export function rangeToDates(range, from, to) {
  const end = to ? new Date(to) : new Date();
  let start;
  if (from) {
    start = new Date(from);
  } else if (range && range !== 'all') {
    const days = ({ '7d': 7, '30d': 30, '90d': 90, '24h': 1 })[range] || 0;
    start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  } else {
    start = new Date(0);
  }
  return { start, end };
}

// Builds a messages WHERE clause + params given global filters.
// First param reserved for user_id ($1) when userId is set; otherwise starts fresh.
export function buildMessageWhere(filters) {
  const clauses = [];
  const params = [];
  const range = rangeToDates(filters.range, filters.from, filters.to);
  clauses.push('m.created_at >= $' + (params.length + 1));
  params.push(range.start);
  clauses.push('m.created_at < $' + (params.length + 1));
  params.push(range.end);
  if (filters.userId) {
    clauses.push('m.user_id = $' + (params.length + 1));
    params.push(filters.userId);
  }
  if (filters.sessionId) {
    clauses.push('m.session_id = $' + (params.length + 1));
    params.push(filters.sessionId);
  }
  if (filters.characterId) {
    clauses.push('m.character_id = $' + (params.length + 1));
    params.push(filters.characterId);
  }
  if (filters.direction) {
    clauses.push('m.direction = $' + (params.length + 1));
    params.push(filters.direction);
  }
  if (filters.chatId) {
    clauses.push('m.chat_id = $' + (params.length + 1));
    params.push(filters.chatId);
  }
  return { where: clauses.join(' AND '), params, range };
}

export function pageMeta(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { total, page, perPage, pages };
}

// Count a fully-qualified SELECT (with alias r) for pagination.
export async function countQuery(sql, params, paramOffset) {
  const wrapped = `SELECT count(*)::int AS n FROM (${sql}) r`;
  const r = await query(wrapped, params.slice(0, paramOffset));
  return r.rows[0].n;
}

export function splitNums(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}
