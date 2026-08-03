import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { query } from '../db.js';
import { signToken, publicUser, requireUser } from '../auth.js';
import { config } from '../config.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 10);
    const apiKey = 'owa_' + crypto.randomBytes(24).toString('hex');
    const r = await query(
      'INSERT INTO users (email, password_hash, name, api_key) VALUES ($1,$2,$3,$4) RETURNING *',
      [email, hash, name, apiKey]
    ).catch(e => {
      if (e.code === '23505') throw new Error('email already registered');
      throw e;
    });
    const user = r.rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const r = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'invalid credentials' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export default router;
export { config };
