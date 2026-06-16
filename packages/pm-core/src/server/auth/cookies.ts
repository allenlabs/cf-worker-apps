import type { Env } from '@allenlabs/pm-core/lib/env';

// Shared attribute string for every auth cookie the adapters emit (the oidc
// `pm_oidc_state` / `pm_session`, and the betterAuth `cfr_session`). Centralized
// so the `SameSite` policy is configured in one place and the SET and CLEAR
// strings always match (a cookie only clears when its attributes match).
//
// Tenant-neutral + backward-compatible: with no env set this returns exactly the
// historical `HttpOnly; Secure; SameSite=Lax; Path=/`.

/**
 * Build the cookie attribute string (everything after `name=value`, minus the
 * trailing `Max-Age` the caller appends). `SameSite` comes from
 * `PM_COOKIE_SAMESITE` (default `lax`); `none` — required for embedded (iframe /
 * cross-origin) deployments so the session survives in-frame navigations — is
 * ALWAYS paired with `Secure` (we set Secure unconditionally anyway). With
 * `SameSite=None`, `PM_COOKIE_PARTITIONED` (`1`/`true`) adds `; Partitioned`
 * (CHIPS); it's ignored for `lax`/`strict`.
 *
 * Returns e.g. `HttpOnly; Secure; SameSite=None; Path=/; Partitioned`.
 */
export function cookieAttrs(env: Env): string {
  const raw = (env.PM_COOKIE_SAMESITE ?? 'lax').toLowerCase();
  const sameSite = raw === 'none' ? 'None' : raw === 'strict' ? 'Strict' : 'Lax';
  const partitioned =
    sameSite === 'None' &&
    (env.PM_COOKIE_PARTITIONED === '1' || env.PM_COOKIE_PARTITIONED === 'true')
      ? '; Partitioned'
      : '';
  return `HttpOnly; Secure; SameSite=${sameSite}; Path=/${partitioned}`;
}
