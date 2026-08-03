import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
router.use(requireUser);

const FIELDS = ['name', 'slug', 'tagline', 'greeting', 'bio', 'personality', 'reply_style', 'extra_rules',
  'languages', 'tags', 'visibility', 'active', 'example_messages', 'typing_profile'];

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'char';
}

router.get('/', async (req, res) => {
  const r = await query('SELECT * FROM characters WHERE user_id=$1 ORDER BY created_at', [req.user.id]);
  res.json({ characters: r.rows });
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const slug = slugify(b.slug || b.name);
    const r = await query(
      `INSERT INTO characters (user_id, name, slug, tagline, greeting, bio, personality, reply_style, extra_rules, languages, tags, visibility, active, example_messages, typing_profile)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.id, b.name || 'New Character', slug, b.tagline || '', b.greeting || '', b.bio || '', b.personality || '',
       b.reply_style || '', b.extra_rules || '', b.languages || ['English'], b.tags || [], b.visibility || 'private',
       b.active !== false, b.example_messages || [], b.typing_profile || null]
    ).catch(e => {
      if (e.code === '23505') throw new Error('slug already used — pick another');
      throw e;
    });
    res.status(201).json({ character: r.rows[0] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const r = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ character: r.rows[0] });
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await query('SELECT * FROM characters WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    const cur = existing.rows[0];
    const patch = {};
    for (const f of FIELDS) {
      if (b[f] !== undefined) patch[f] = b[f];
    }
    if (patch.slug !== undefined) patch.slug = slugify(patch.slug);
    if (!Object.keys(patch).length) return res.json({ character: cur });
    const setClause = Object.keys(patch).map((k, i) => `${k}=$${i + 2}`).join(', ');
    const values = Object.values(patch);
    const r = await query(`UPDATE characters SET ${setClause}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [req.params.id, req.user.id, ...values]);
    res.json({ character: r.rows[0] });
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
