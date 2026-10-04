import { describe, expect, it } from 'vitest';
import {
  extractFromHtml,
  extractFromUrl,
  sanitize,
  EMPTY_EXTRACTION,
} from '~/lib/reader';

const ARTICLE_HTML = `
<!doctype html>
<html>
<head>
  <title>Test Page</title>
  <meta property="og:title" content="OG Title">
  <meta name="description" content="Short meta description">
</head>
<body>
  <header>
    <nav>Top nav links</nav>
  </header>
  <main>
    <article>
      <h1>Reader Mode Headline</h1>
      <p>This is a substantial paragraph of body text written for ADHD developers to read later. ${'word '.repeat(50)}</p>
      <p>${'lorem ipsum dolor sit amet '.repeat(40)}</p>
      <p>${'second paragraph '.repeat(60)}</p>
      <ul><li>one</li><li>two</li></ul>
      <script>alert('xss');</script>
    </article>
  </main>
  <footer>page footer</footer>
</body>
</html>
`;

const NON_ARTICLE_HTML = `
<!doctype html>
<html><head>
  <title>Bare</title>
  <meta property="og:title" content="OG Fallback">
  <meta name="description" content="Just an OG description.">
</head><body><div>tiny</div></body></html>
`;

describe('sanitize', () => {
  it('strips <script> tags', () => {
    const out = sanitize('<p>ok</p><script>bad()</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('script');
  });
  it('forces target=_blank + rel on anchors', () => {
    const out = sanitize('<a href="https://example.com">x</a>');
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="noopener noreferrer"/);
  });
  it('drops javascript: URLs', () => {
    const out = sanitize('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });
  it('keeps img tags + src', () => {
    const out = sanitize('<img src="https://x/y.png" alt="y">');
    expect(out).toContain('<img');
    expect(out).toContain('src="https://x/y.png"');
  });
});

describe('extractFromHtml', () => {
  it('returns EMPTY_EXTRACTION for empty input', () => {
    expect(extractFromHtml('', 'https://example.com')).toEqual(EMPTY_EXTRACTION);
  });

  it('extracts title + content + word count from a real article', () => {
    const r = extractFromHtml(ARTICLE_HTML, 'https://example.com/post');
    expect(r.title).toBeTruthy();
    expect(r.contentHtml).toBeTruthy();
    expect(r.contentHtml).not.toMatch(/<script/);
    expect(r.wordCount).toBeGreaterThan(50);
    expect(r.estimatedMinutes).toBeGreaterThanOrEqual(1);
  });

  it('falls back to OG meta for non-article pages', () => {
    const r = extractFromHtml(NON_ARTICLE_HTML, 'https://example.com/bare');
    // Readability may either return null (→ OG fallback) or a tiny extraction.
    // Either way we should at least have a title.
    expect(r.title).toBeTruthy();
  });

  it('returns null estimatedMinutes when no body extracted', () => {
    const r = extractFromHtml(NON_ARTICLE_HTML, 'https://example.com/bare');
    if (!r.contentHtml) {
      expect(r.estimatedMinutes).toBeNull();
      expect(r.wordCount).toBeNull();
    }
  });

  it('falls back to OG title for completely empty content', () => {
    const html = `<html><head><meta property="og:title" content="O"><meta property="og:description" content="D"></head><body></body></html>`;
    const r = extractFromHtml(html, 'https://x');
    expect(r.title).toBe('O');
    expect(r.excerpt).toBe('D');
  });

  it('falls back to twitter: meta when og is missing', () => {
    const html = `<html><head><meta name="twitter:title" content="T"><meta name="twitter:description" content="TD"></head><body></body></html>`;
    const r = extractFromHtml(html, 'https://x');
    expect(r.title).toBe('T');
    expect(r.excerpt).toBe('TD');
  });

  it('falls back to <title> when no meta tags', () => {
    const html = `<html><head><title>Plain Title</title></head><body></body></html>`;
    const r = extractFromHtml(html, 'https://x');
    expect(r.title).toBe('Plain Title');
  });

  it('returns null title when nothing extractable', () => {
    const html = `<html><head></head><body></body></html>`;
    const r = extractFromHtml(html, 'https://x');
    expect(r.title).toBeNull();
    expect(r.excerpt).toBeNull();
  });

  it('ignores empty meta content values', () => {
    const html = `<html><head><meta property="og:title" content="  "><title>fallback</title></head><body></body></html>`;
    const r = extractFromHtml(html, 'https://x');
    expect(r.title).toBe('fallback');
  });
});

describe('extractFromUrl', () => {
  function makeFetch(response: { status?: number; ct?: string; body?: string }): typeof globalThis.fetch {
    return (async () => {
      return new Response(response.body ?? '', {
        status: response.status ?? 200,
        headers: { 'content-type': response.ct ?? 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  it('returns empty when fetch throws', async () => {
    const r = await extractFromUrl('https://x', {
      fetch: (() => Promise.reject(new Error('network'))) as unknown as typeof globalThis.fetch,
    });
    expect(r).toEqual(EMPTY_EXTRACTION);
  });

  it('returns empty on non-2xx status', async () => {
    const r = await extractFromUrl('https://x', { fetch: makeFetch({ status: 404 }) });
    expect(r).toEqual(EMPTY_EXTRACTION);
  });

  it('returns empty on non-HTML content-type', async () => {
    const r = await extractFromUrl('https://x', {
      fetch: makeFetch({ ct: 'application/json', body: '{}' }),
    });
    expect(r).toEqual(EMPTY_EXTRACTION);
  });

  it('extracts on a real HTML response', async () => {
    const r = await extractFromUrl('https://x', {
      fetch: makeFetch({ body: ARTICLE_HTML }),
    });
    expect(r.title).toBeTruthy();
    expect(r.contentHtml).toBeTruthy();
  });

  it('handles XHTML content-type', async () => {
    const r = await extractFromUrl('https://x', {
      fetch: makeFetch({ ct: 'application/xhtml+xml', body: ARTICLE_HTML }),
    });
    expect(r.title).toBeTruthy();
  });
});
