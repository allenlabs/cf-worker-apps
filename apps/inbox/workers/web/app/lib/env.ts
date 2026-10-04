// Cloudflare bindings + env vars/secrets for the inbox web worker.
//
// Locally these come from wrangler (.dev.vars); in production they come from
// the bindings configured in wrangler.toml and `wrangler secret put`.

export interface Env {
  HYPERDRIVE: Hyperdrive;
  // Suite-wide JWT revocation list lives in the auth D1 (allenlabs-auth-d1,
  // APAC). Each web worker binds it read+write; the `revoked_sessions` table
  // (apps/auth/migrations-d1/0007_revoked_sessions.sql) is shared across the
  // whole suite so a logout on one app blocks the JWT everywhere. Replaces
  // the per-app SESSION_KV namespaces that lived in Workers KV.
  AUTH_DB: D1Database;
  ASSETS: Fetcher;

  // vars (from wrangler.toml [vars])
  APP_NAME: string;
  DEFAULT_LANGUAGE: string;

  // SSO — both must point at the same allenlabs-auth deployment.  Sign-in
  // happens at AUTH_WEB_URL/sign-in; inbox exchanges codes and verifies JWTs
  // against AUTH_API_URL.
  AUTH_WEB_URL: string;       // e.g. https://auth.allen.company
  AUTH_API_URL: string;       // e.g. https://auth-api.allen.company

  // Used by /auth/login to build a callback URL the auth-web worker can
  // redirect back to.
  PUBLIC_BASE_URL: string;

  // OpenTelemetry → Grafana LGTM.  Three gates in front of the collector
  // (WAF Bearer, Cloudflare Access service token, the OTLP collector
  // itself).  Wrangler secrets.
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // Web Push (VAPID).  `VAPID_PUBLIC_KEY` is the application server key
  // browsers use to scope subscriptions — safe to embed in the client
  // bundle / HTML.  `VAPID_PRIVATE_KEY` is the signing key for outbound
  // pushes; never leaves the worker.  `VAPID_SUBJECT` is the RFC 8292
  // contact URI, e.g. `mailto:ops@allenlabs.org`.
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}
