// Shared SSRF / internal-address host guard. Originally inlined in
// handlers/automations.ts (isSafeWebhookUrl); extracted so the external-Postgres
// DataSource (datasource/postgres.ts) can reuse the exact same classification
// when validating a user-supplied connection target.
//
// Pure + unit-tested. Rejects anything we can't confidently classify as public.

/**
 * True iff `host` (a bare hostname, no brackets) is a loopback / link-local /
 * private / cloud-metadata address — i.e. NOT a safe public target. Mirrors the
 * original webhook guard's ruleset exactly so behavior is preserved.
 */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' ) return true;
  // Obvious names.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // Cloud metadata endpoint (IMDS) — both the IPv4 + the common alias.
  if (h === '169.254.169.254' || h === 'metadata' || h === 'metadata.google.internal') {
    return true;
  }
  // IPv6 loopback / link-local / unique-local.
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  // IPv4 literal ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 0) return true; // "this host"
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/**
 * True iff `url` is a safe outbound HTTP(S) webhook target: http(s) only, and
 * NOT an internal/metadata address. (Unchanged behavior — used by send_webhook.)
 */
export function isSafeHttpUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isBlockedHost(u.hostname);
}

/**
 * True iff `connectionString` is a safe EXTERNAL Postgres target: a postgres://
 * (or postgresql://) URL whose host is NOT loopback/private/metadata. Used by
 * the external-PG DataSource to refuse SSRF-style connections to our own
 * infra/metadata before opening a socket.
 */
export function isSafePostgresConnectionString(connectionString: string): boolean {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return false;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false;
  if (!u.hostname) return false;
  return !isBlockedHost(u.hostname);
}
