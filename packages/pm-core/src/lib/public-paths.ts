// Path classification for the root auth gate. Pure (no runtime deps) so it can
// be unit-tested; the worker runs for every path (static assets aren't
// auto-served here), so the gate MUST let public bundles through or an expired
// session redirects CSS/JS to /auth/login and the page renders unstyled.

const STATIC_EXT =
  /\.(css|js|mjs|map|svg|png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|json|txt|xml|wasm)$/i;

/**
 * True for hashed build assets and any path with a static-file extension
 * (favicon, fonts, source maps, …). These are public and must never be
 * auth-redirected — otherwise a lapsed JWT turns a stylesheet request into a
 * 307 to login and the page loses its styles.
 */
export function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  return STATIC_EXT.test(pathname);
}
