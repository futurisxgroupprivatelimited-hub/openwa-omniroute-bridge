import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
router.use(requireUser);

const FIELDS = ['name', 'slug', 'tagline', 'greeting', 'bio', 'personality', 'reply_style', 'extra_rules',
  'languages', 'tags', 'visibility', 'active', 'example_messages', 'typing_profile',
  'knowledge_base', 'social_links', 'drive_link', 'source_links', 'sources_verified'];

const JSONB_FIELDS = new Set(['example_messages', 'typing_profile', 'social_links', 'source_links']);

export function jsonb(v) {
  if (typeof v === 'string') return v;
  return JSON.stringify(v ?? null);
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'char';
}

export function asArray(v) {
  return Array.isArray(v) ? v : [];
}

export function normalizeCharacter(c) {
  if (!c) return c;
  c.example_messages = asArray(c.example_messages);
  c.social_links = asArray(c.social_links);
  c.source_links = asArray(c.source_links);
  c.languages = asArray(c.languages);
  c.tags = asArray(c.tags);
  return c;
}

router.get('/', async (req, res) => {
  const r = await query('SELECT * FROM characters WHERE user_id=$1 ORDER BY created_at', [req.user.id]);
  res.json({ characters: r.rows.map(normalizeCharacter) });
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const slug = slugify(b.slug || b.name);
    const r = await query(
      `INSERT INTO characters (user_id, name, slug, tagline, greeting, bio, personality, reply_style, extra_rules, languages, tags, visibility, active, example_messages, typing_profile, knowledge_base, social_links, drive_link, source_links, sources_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [req.user.id, b.name || 'New Character', slug, b.tagline || '', b.greeting || '', b.bio || '', b.personality || '',
       b.reply_style || '', b.extra_rules || '', asArray(b.languages).length ? b.languages : ['English'], asArray(b.tags), b.visibility || 'private',
       b.active !== false, jsonb(asArray(b.example_messages)), jsonb(b.typing_profile || null),
       b.knowledge_base || '', jsonb(asArray(b.social_links)), b.drive_link || '', jsonb(asArray(b.source_links)), !!b.sources_verified]
    ).catch(e => {
      if (e.code === '23505') throw new Error('slug already used — pick another');
      throw e;
    });
    res.status(201).json({ character: normalizeCharacter(r.rows[0]) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const r = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ character: normalizeCharacter(r.rows[0]) });
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    const cur = existing.rows[0];
    const patch = {};
    for (const f of FIELDS) {
      if (b[f] !== undefined) patch[f] = JSONB_FIELDS.has(f) ? jsonb(b[f]) : b[f];
    }
    if (patch.slug !== undefined) patch.slug = slugify(patch.slug);
    if (!Object.keys(patch).length) return res.json({ character: cur });
    const setClause = Object.keys(patch).map((k, i) => `${k}=$${i + 3}`).join(', ');
    const values = Object.values(patch);
    const r = await query(`UPDATE characters SET ${setClause}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.user.id, ...values]);
    res.json({ character: normalizeCharacter(r.rows[0]) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const r = await query('DELETE FROM characters WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

export default router;
