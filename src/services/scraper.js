// Source scraping for smart character auto-generation.
// Primary: jina.ai reader (free, no key) returns markdown for any public URL.
// Fallback: direct HTML fetch + tag stripping.

const MAX_CHARS = 40000;

export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\t\r\n]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

export function cleanText(text) {
  return decodeEntities(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, MAX_CHARS);
}

export function isValidUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(m[1]) : '';
}

export function extractMeta(html) {
  const og = {};
  const re = /<meta[^>]+(?:property|name)=["'](?:og:|description|twitter:description)["'][^>]*content=["']([^"']+)["']/gi;
  let mm;
  while ((mm = re.exec(html))) og[mm[2]] = mm[1];
  return Object.values(og).map(cleanText).filter(Boolean).join(' ');
}

async function scrapeJina(url) {
  const res = await fetch('https://r.jina.ai/' + url, {
    headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0 OpenBridge-scraper/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('reader ' + res.status);
  const text = (await res.text()).slice(0, MAX_CHARS);
  if (!text || text.length < 40) throw new Error('empty content');
  return text;
}

async function scrapeDirect(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const title = pageTitle(html);
  const meta = extractMeta(html);
  const body = cleanText(stripHtml(html));
  const text = cleanText([title, meta, body].join('\n\n'));
  if (text.length < 40) throw new Error('page too thin');
  return text;
}

export async function scrapeUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!isValidUrl(url)) return { url, status: 'error', error: 'not a valid http(s) URL' };
  const errors = [];
  for (const fn of [scrapeJina, scrapeDirect]) {
    try {
      const text = await fn(url);
      return { url, status: 'ok', text, wordCount: text.split(/\s+/).length };
    } catch (e) {
      errors.push(fn === scrapeJina ? 'reader: ' + e.message : 'direct: ' + e.message);
    }
  }
  return { url, status: 'error', error: errors.join('; ') };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scrapeMany(links) {
  const list = (Array.isArray(links) ? links : []).filter(Boolean).map(String).map(s => s.trim()).filter(Boolean).slice(0, 8);
  const results = await mapLimit(list, 4, url => scrapeUrl(url));
  return results.map(r => ({ ...r, title: '', excerpt: r.text ? r.text.slice(0, 600) : '' }));
}
