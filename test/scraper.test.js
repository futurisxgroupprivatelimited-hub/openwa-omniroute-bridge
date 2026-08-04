import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidUrl, pageTitle, extractMeta, cleanText, stripHtml, decodeEntities, scrapeUrl, scrapeMany,
} from '../src/services/scraper.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// helper: install a fake fetch that returns a Response for url matches
function fakeFetch(routes) {
  globalThis.fetch = async (url, opts) => {
    const hit = routes.find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return new Response('NOT FOUND', { status: 404 });
    const [, body, status = 200] = hit;
    return new Response(body, { status });
  };
}

// ── isValidUrl ────────────────────────────────────────────────────
test('isValidUrl: accepts http/https', () => {
  assert.equal(isValidUrl('https://example.com/a?b=1'), true);
  assert.equal(isValidUrl('http://example.com'), true);
});

test('isValidUrl: rejects invalid and non-http schemes', () => {
  assert.equal(isValidUrl('ftp://x.com'), false);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidUrl(''), false);
  assert.equal(isValidUrl('javascript:alert(1)'), false);
  assert.equal(isValidUrl('file:///etc/passwd'), false);
  assert.equal(isValidUrl(undefined), false);
});

// ── decodeEntities ────────────────────────────────────────────────
test('decodeEntities: decodes common HTML entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;tag&gt; &quot;q&quot; &#39;apos&#39; &apos;x&apos;'), 'a & b <tag> "q" \'apos\' \'x\'');
  assert.equal(decodeEntities('&#65;&#66;'), 'AB');
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
});

// ── stripHtml ─────────────────────────────────────────────────────
test('stripHtml: removes tags and script/style/noscript blocks', () => {
  const html = '<p>Hello</p><script>var x=1;</script><style>.a{}</style><noscript>no</noscript><div><b>World</b></div>';
  const out = stripHtml(html);
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('<style'));
  assert.ok(!out.includes('<p>'));
  assert.ok(out.includes('Hello'));
  assert.ok(out.includes('World'));
});

// ── cleanText ─────────────────────────────────────────────────────
test('cleanText: trims lines, collapses whitespace, strips control chars', () => {
  const out = cleanText('  a \t\t b  \n\n  \n c ');
  assert.equal(out, 'a b\nc');
});

test('cleanText: strips control characters', () => {
  assert.ok(!cleanText('a\u0000b\u001f\u007fc').includes('\u0000'));
});

test('cleanText: caps at MAX_CHARS (40000)', () => {
  const out = cleanText('x'.repeat(60000));
  assert.ok(out.length <= 40000);
});

// ── pageTitle ─────────────────────────────────────────────────────
test('pageTitle: extracts <title> text', () => {
  assert.equal(pageTitle('<html><title>  My Page  </title></html>'), 'My Page');
  assert.equal(pageTitle('<html><title>A &amp; B</title></html>'), 'A & B');
});

test('pageTitle: returns empty string when absent', () => {
  assert.equal(pageTitle('<html></html>'), '');
  assert.equal(pageTitle(''), '');
});

// ── extractMeta ───────────────────────────────────────────────────
test('extractMeta: pulls og:/description/twitter:description metas', () => {
  const html = [
    '<meta property="og:title" content="T">',
    '<meta name="description" content="D">',
    '<meta name="twitter:description" content="TD">',
    '<meta property="og:image" content="IMG">',
  ].join('');
  const out = extractMeta(html);
  assert.ok(out.includes('T'));
  assert.ok(out.includes('D'));
  assert.ok(out.includes('TD'));
  assert.ok(!out.includes('IMG')); // og:image is not matched
});

test('extractMeta: returns empty string when no meta tags', () => {
  assert.equal(extractMeta('<html></html>'), '');
});

// ── scrapeUrl (network mocked) ────────────────────────────────────
test('scrapeUrl: uses jina reader path when it succeeds', async () => {
  fakeFetch([
    ['https://r.jina.ai/https://wiki.example.org/X', '# Title\nBody text with enough words to pass the 40 char threshold.', 200],
  ]);
  const r = await scrapeUrl('https://wiki.example.org/X');
  assert.equal(r.status, 'ok');
  assert.ok(r.wordCount >= 10);
});

test('scrapeUrl: falls back to direct HTML scrape when reader fails', async () => {
  fakeFetch([
    ['https://r.jina.ai/https://site.example.com/', 'FAIL', 500],
    ['https://site.example.com/', '<html><head><title>Direct Page</title></head><body><p>Plenty of content here to extract and it should be long enough.</p></body></html>', 200],
  ]);
  const r = await scrapeUrl('https://site.example.com/');
  assert.equal(r.status, 'ok');
  assert.ok(r.text.includes('Direct Page'));
});

test('scrapeUrl: reports error when both strategies fail', async () => {
  fakeFetch([
    ['https://r.jina.ai/', 'x', 500],
    ['https://dead.example/', 'gone', 404],
  ]);
  const r = await scrapeUrl('https://dead.example/');
  assert.equal(r.status, 'error');
  assert.ok(r.error.length > 0);
});

test('scrapeUrl: rejects invalid URLs without network', async () => {
  const r = await scrapeUrl('not-a-url');
  assert.equal(r.status, 'error');
  assert.match(r.error, /valid/i);
});

// ── scrapeMany ────────────────────────────────────────────────────
test('scrapeMany: processes up to 8 links and tags excerpts', async () => {
  const mk = (i) => [
    [`https://r.jina.ai/https://s${i}.example/`, 'word '.repeat(300), 200],
    [`https://s${i}.example/`, 'ignored', 404],
  ];
  const routes = [];
  for (let i = 1; i <= 9; i++) routes.push(...mk(i));
  fakeFetch(routes);
  const links = Array.from({ length: 9 }, (_, i) => `https://s${i + 1}.example/`);
  const out = await scrapeMany(links);
  assert.equal(out.length, 8);
  for (const s of out) {
    assert.equal(s.status, 'ok');
    assert.ok(s.excerpt.length > 0);
  }
});

test('scrapeMany: skips blanks and tolerates empty input', async () => {
  fakeFetch([]);
  assert.deepEqual(await scrapeMany([]), []);
  assert.deepEqual(await scrapeMany(['', '  ', null]), []);
});
