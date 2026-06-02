/** A recognised embed provider (or "generic" for an arbitrary URL). */
export type EmbedProvider = 'youtube' | 'vimeo' | 'figma' | 'googlemaps' | 'generic';

/** The result of normalizing a raw URL into an embeddable iframe source. */
export interface NormalizedEmbed {
  /** The iframe `src` URL. */
  embedUrl: string;
  /** Which provider matched (for analytics / styling). */
  provider: EmbedProvider;
}

/** Safely parse a URL; returns null for anything that isn't a valid http(s) URL. */
function parse(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Normalize a pasted/typed URL into an embeddable iframe source + provider tag.
 *
 * - YouTube (`youtube.com/watch?v=`, `youtu.be/<id>`, `/embed/`, `/shorts/`) →
 *   `https://www.youtube.com/embed/<id>`.
 * - Vimeo (`vimeo.com/<id>`) → `https://player.vimeo.com/video/<id>`.
 * - Figma (`figma.com/file|design|proto/...`) → the official `figma.com/embed`
 *   wrapper with the original URL as `embed_host`.
 * - Google Maps (`google.com/maps`, `goo.gl/maps`, `maps.app.goo.gl`) → the
 *   `output=embed` form when possible, else the raw URL.
 * - Anything else → the URL as-is (generic sandboxed iframe).
 *
 * Returns `null` for input that isn't a valid http(s) URL, so callers can
 * reject junk before inserting a node. Pure → unit-tested.
 */
export function normalizeEmbed(rawUrl: string): NormalizedEmbed | null {
  const u = parse(rawUrl);
  if (!u) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // --- YouTube ---
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.searchParams.get('v') ?? '';
    if (!id) {
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/);
      if (m) id = m[1]!;
    }
    if (id) return { embedUrl: `https://www.youtube.com/embed/${id}`, provider: 'youtube' };
  }
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0] ?? '';
    if (id) return { embedUrl: `https://www.youtube.com/embed/${id}`, provider: 'youtube' };
  }

  // --- Vimeo ---
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    if (host === 'player.vimeo.com') {
      return { embedUrl: u.toString(), provider: 'vimeo' };
    }
    const m = u.pathname.match(/\/(\d+)/);
    if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, provider: 'vimeo' };
  }

  // --- Figma ---
  if (host === 'figma.com') {
    if (u.pathname.startsWith('/embed')) {
      return { embedUrl: u.toString(), provider: 'figma' };
    }
    if (/^\/(file|design|proto|board)\//.test(u.pathname)) {
      const embed = new URL('https://www.figma.com/embed');
      embed.searchParams.set('embed_host', 'allenlabs');
      embed.searchParams.set('url', u.toString());
      return { embedUrl: embed.toString(), provider: 'figma' };
    }
  }

  // --- Google Maps ---
  if (host === 'google.com' || host === 'maps.google.com' || host.endsWith('.google.com')) {
    if (u.pathname.startsWith('/maps')) {
      // The classic embeddable form just needs output=embed.
      const embed = new URL(u.toString());
      embed.searchParams.set('output', 'embed');
      return { embedUrl: embed.toString(), provider: 'googlemaps' };
    }
  }
  if (host === 'maps.app.goo.gl' || host === 'goo.gl') {
    // Shortened links can't be rewritten client-side; embed as-is.
    return { embedUrl: u.toString(), provider: 'googlemaps' };
  }

  // --- Generic ---
  return { embedUrl: u.toString(), provider: 'generic' };
}

/**
 * Whether a string is a single bare URL on its own (no surrounding text). Used
 * by the paste handler to decide whether a pasted clipboard string is "just a
 * link" worth turning into an embed.
 */
export function isBareUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return parse(t) !== null;
}

/**
 * Whether a bare URL belongs to an auto-embed provider (YouTube/Vimeo/Figma).
 * Pasting one of these on its own line becomes an embed; a generic URL is left
 * alone (so ordinary links still paste as links).
 */
export function isAutoEmbedUrl(text: string): boolean {
  if (!isBareUrl(text)) return false;
  const norm = normalizeEmbed(text);
  return !!norm && (norm.provider === 'youtube' || norm.provider === 'vimeo' || norm.provider === 'figma');
}
