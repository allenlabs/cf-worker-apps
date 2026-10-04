// Server-side locale plumbing: read cookie + Accept-Language, build Set-Cookie
// for the language switcher. Used by SSR route loaders and Hono handlers.

import { normalizeLocale, type Locale, DEFAULT_LOCALE } from "./index";

/** Cookie name carrying the user's explicit choice. Shared across the suite. */
export const LANG_COOKIE_NAME = "lang";

/**
 * Pick the locale for a request by priority:
 *   1. `lang` cookie (last explicit user choice)
 *   2. `jwtLocale` argument (durable profile preference from auth JWT)
 *   3. `Accept-Language` header (browser preference)
 *   4. {@link DEFAULT_LOCALE}
 */
export function resolveLocale(
  request: Request,
  jwtLocale?: string | null,
): Locale {
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const m = cookieHeader.match(/(?:^|;\s*)lang=([^;]+)/);
    if (m && m[1]) return normalizeLocale(decodeURIComponent(m[1]));
  }
  if (jwtLocale) return normalizeLocale(jwtLocale);
  const accept = request.headers.get("accept-language");
  if (accept) {
    // Pick the first valid 2-letter tag in priority order. We don't fully
    // parse the q-weighted list — the first listed language is the user's
    // top choice in every browser we care about.
    const first = accept.split(",")[0]?.trim().split(";")[0];
    if (first) return normalizeLocale(first);
  }
  return DEFAULT_LOCALE;
}

/**
 * Build a `Set-Cookie` header value for the language preference. Pass the
 * cookie domain explicitly so each app uses the right scope (e.g.
 * `.allenlabs.org` for the suite, `auth.allen.company` for auth).
 */
export function buildLangCookie(
  locale: Locale,
  opts: { domain?: string; maxAgeDays?: number } = {},
): string {
  const maxAge = (opts.maxAgeDays ?? 365) * 24 * 60 * 60;
  const parts = [
    `${LANG_COOKIE_NAME}=${locale}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
    "Secure",
  ];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join("; ");
}
