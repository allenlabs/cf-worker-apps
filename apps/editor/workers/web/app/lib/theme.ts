// Phase 14: light/dark theme plumbing.
//
// The chosen theme is stored in a suite-wide `theme` cookie on .allenlabs.org
// (same scope as the `lang` cookie) so SSR can emit the correct
// `<html class="dark">` on the first paint — no flash. The toggle writes the
// cookie client-side and reloads (mirrors the LanguagePicker pattern).

export type Theme = 'light' | 'dark';

export const THEME_COOKIE_NAME = 'theme';

/** Parse the `theme` cookie out of a Cookie header; defaults to 'light'. */
export function readThemeFromCookie(cookieHeader: string | null | undefined): Theme {
  if (!cookieHeader) return 'light';
  const m = cookieHeader.match(/(?:^|;\s*)theme=([^;]+)/);
  const v = m?.[1] ? decodeURIComponent(m[1]) : '';
  return v === 'dark' ? 'dark' : 'light';
}

/** Write the suite-wide theme cookie (client-side). */
export function setThemeCookie(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const maxAge = 365 * 24 * 60 * 60;
  document.cookie = `${THEME_COOKIE_NAME}=${theme}; Path=/; Domain=.allenlabs.org; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}
