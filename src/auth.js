import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: u.plan,
    role: u.role || 'user',
    api_key: u.api_key,
    webhook_token: u.webhook_token,
    webhook_secret: u.webhook_secret,
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
    created_at: u.created_at,
  };
}

export async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const apiKey = req.headers['x-api-key'];
    let user = null;

    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const decoded = jwt.verify(token, config.jwtSecret);
      const r = await query('SELECT * FROM users WHERE id = $1', [decoded.sub]);
      user = r.rows[0];
    } else if (apiKey) {
      const r = await query('SELECT * FROM users WHERE api_key = $1', [apiKey]);
      user = r.rows[0];
    }

    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
}

export async function requireAdmin(req, res, next) {
  if ((req.user?.role || 'user') !== 'admin') {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  next();
}
