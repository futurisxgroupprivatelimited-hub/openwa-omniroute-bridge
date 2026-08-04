import { Router } from 'express';
import { requireUser } from '../auth.js';
import { scrapeMany } from '../services/scraper.js';
import { completeJson } from '../services/omniroute.js';

const router = Router();
router.use(requireUser);

// Step 1: scrape public sources (website, wiki, instagram, facebook, …)
router.post('/scrape', async (req, res) => {
  try {
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    if (!links.length) return res.status(400).json({ error: 'paste at least one link' });
    const sources = await scrapeMany(links);
    res.json({ sources, ok: sources.filter(s => s.status === 'ok').length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Step 2: generate a complete character profile from scraped text
router.post('/generate', async (req, res) => {
  try {
    const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
    const usable = sources.filter(s => s.status === 'ok' && s.text);
    if (!usable.length) return res.status(400).json({ error: 'no usable scraped content — check your links' });

    const hint = String(req.body?.hint || '').trim();
    const sourceText = usable.map(s => `--- SOURCE: ${s.url} ---\n${s.text.slice(0, 4500)}`).join('\n\n').slice(0, 40000);

    const prompt = [
      'You are building a professional WhatsApp AI character profile. The character will chat like a real human (a person, a company receptionist, or a sales agent).',
      `Use ONLY the scraped information below. Do not invent facts.`,
      hint ? `USER GOAL: ${hint}` : '',
      '',
      sourceText,
      '',
      'Return STRICT JSON (no markdown) with exactly this shape:',
      '{',
      '  "name": "character display name",',
      '  "tagline": "one short line",',
      '  "greeting": "first message a new chat receives, casual WhatsApp style",',
      '  "bio": "2-4 sentences",',
      '  "personality": "how they behave, warm + professional",',
      '  "reply_style": "short, natural WhatsApp style, never robotic",',
      '  "extra_rules": "additional behavioral rules, e.g. never reveal being AI, redirect sales questions",',
      '  "languages": ["English"],',
      '  "tags": ["category", "category"],',
      '  "knowledge_base": "a compact fact sheet (200-500 words) with the key verified facts, contact details, products, hours, FAQ answers",',
      '  "example_messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]',
      '}',
    ].join('\n');

    const msgs = [{ role: 'system', content: 'You output JSON only. You never reveal that you are an AI.' }, { role: 'user', content: prompt }];
    const draft = await completeJson(req.user, msgs);
    const name = String(draft.name || '').trim();
    if (!name) throw new Error('LLM returned no character name');
    res.json({ draft, sources: usable.map(s => ({ url: s.url, title: s.title, wordCount: s.wordCount })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
