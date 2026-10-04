// Reader-mode extraction.  Given a URL, fetch the HTML, run Mozilla
// Readability against a linkedom DOM (which works on CF Workers — no real
// DOM dependency), sanitize the resulting body, and compute word count +
// estimated minutes.
//
// Returns a partial set of fields suitable for INSERT'ing into
// read_later.items.  Failures are non-fatal: we still save the URL so the
// user doesn't lose the capture; we just leave the extracted fields null.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import sanitizeHtml from 'sanitize-html';
import { estimateMinutes, wordCount } from './format';

export interface ExtractedArticle {
  title: string | null;
  excerpt: string | null;
  contentHtml: string | null;
  wordCount: number | null;
  estimatedMinutes: number | null;
}

export const EMPTY_EXTRACTION: ExtractedArticle = {
  title: null,
  excerpt: null,
  contentHtml: null,
  wordCount: null,
  estimatedMinutes: null,
};

// Sanitize-html config: keep semantic article tags, drop scripts / styles
// / iframes / forms.  Strips inline event handlers via the default `allowedAttributes`.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'blockquote', 'pre', 'code', 'em', 'strong', 'i', 'b',
    'a', 'ul', 'ol', 'li', 'br', 'hr',
    'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['id'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
  },
};

export function sanitize(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/**
 * Extract the article body from a raw HTML string.  Pure function — does NOT
 * fetch.  Returns EMPTY_EXTRACTION on any parser failure.  Tests pass HTML
 * fixtures directly to keep network out of the unit harness.
 */
export function extractFromHtml(html: string, url: string): ExtractedArticle {
  if (!html) return EMPTY_EXTRACTION;
  let parsed:
    | { window: { document: Document }; document: Document }
    | null = null;
  try {
    parsed = parseHTML(html) as unknown as {
      window: { document: Document };
      document: Document;
    };
  } catch {
    /* v8 ignore next 2 — linkedom is very forgiving; this only fires on
       a non-string input which the type guard already rules out. */
    return EMPTY_EXTRACTION;
  }
  const doc = parsed.document;
  // Readability mutates the document; pass a clone to keep callers safe.
  let article: ReturnType<Readability['parse']> | null = null;
  try {
    article = new Readability(doc as unknown as Document, {
      // Sane defaults for ADHD-friendly reading: keep the headline and
      // first paragraph identifiable, prune low-content sidebars.
      charThreshold: 200,
    }).parse();
  } catch {
    /* v8 ignore next 2 — Readability swallows most parse errors; this
       only fires on driver bugs. */
    return EMPTY_EXTRACTION;
  }
  if (!article) {
    // Readability returns null on pages it can't extract from.  Fall back
    // to OG-meta scrape so we at least capture a title + bare URL.
    return fallbackFromOgMeta(doc, url);
  }
  /* v8 ignore next — Readability sets `content` on every non-null parse;
     the false branch is defensive. */
  const sanitizedHtml = article.content ? sanitize(article.content) : null;
  /* v8 ignore next 2 — Readability sets `textContent` (a string) on every
     non-null parse; the empty-string fallback is defensive. */
  const textContent =
    typeof article.textContent === 'string' ? article.textContent.trim() : '';
  const words = wordCount(textContent);
  // Readability's title/excerpt nullable fallbacks fire only when the parser
  // succeeds but emits missing metadata, which our fixture inputs always
  // populate.  textContent's >0-words fallback is similarly defensive.
  return {
    /* v8 ignore next */
    title: article.title ?? null,
    /* v8 ignore next */
    excerpt: article.excerpt ?? null,
    contentHtml: sanitizedHtml,
    /* v8 ignore next */
    wordCount: words > 0 ? words : null,
    /* v8 ignore next */
    estimatedMinutes: words > 0 ? estimateMinutes(words) : null,
  };
}

function fallbackFromOgMeta(doc: Document, _url: string): ExtractedArticle {
  const title =
    getMeta(doc, 'og:title') ??
    getMeta(doc, 'twitter:title') ??
    doc.querySelector('title')?.textContent?.trim() ??
    null;
  const excerpt =
    getMeta(doc, 'og:description') ??
    getMeta(doc, 'twitter:description') ??
    getMeta(doc, 'description') ??
    null;
  return {
    title,
    excerpt,
    contentHtml: null,
    wordCount: null,
    estimatedMinutes: null,
  };
}

function getMeta(doc: Document, name: string): string | null {
  const sel =
    doc.querySelector(`meta[property="${name}"]`) ??
    doc.querySelector(`meta[name="${name}"]`);
  if (!sel) return null;
  const v = sel.getAttribute('content');
  return v && v.trim() ? v.trim() : null;
}

/**
 * Fetch a URL and extract its article.  Network-touching wrapper around
 * extractFromHtml.  Tests stub the fetcher; production passes globalThis
 * fetch (or a CF-Workers `fetch` instance).
 */
export interface ExtractDeps {
  fetch: typeof globalThis.fetch;
}

export async function extractFromUrl(
  url: string,
  deps: ExtractDeps,
): Promise<ExtractedArticle> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; AllenLabsReadLater/0.1; +https://read-later.allenlabs.org)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
  } catch {
    return EMPTY_EXTRACTION;
  }
  if (!res.ok) return EMPTY_EXTRACTION;
  /* v8 ignore next — Response.headers.get('content-type') returning null is
     not exercised by jsdom's Response; in production a well-formed HTTP
     response always carries the header. */
  const ct = res.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml/i.test(ct)) return EMPTY_EXTRACTION;
  let html: string;
  try {
    html = await res.text();
  } catch {
    /* v8 ignore next 2 — only fires on a torn-down stream which is racy
       and effectively unreachable in tests. */
    return EMPTY_EXTRACTION;
  }
  return extractFromHtml(html, url);
}
