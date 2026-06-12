// Cloudflare bindings + env vars/secrets available to the worker at runtime.
//
// Locally these come from wrangler (.dev.vars) ; in production they come from
// the bindings configured in wrangler.toml and `wrangler secret put`.

export interface Env {
  HYPERDRIVE: Hyperdrive;
  FILES: R2Bucket;
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
  ATTACHMENT_TTL_DAYS?: string;

  // Selects the auth adapter (server/auth/registry.ts); defaults to 'betterAuth'.
  // The AUTH_WEB_URL/AUTH_API_URL/PM_ORG_HMAC_* below are the betterAuth adapter's
  // config — a second deployment points them at its own Better Auth auth-api.
  AUTH_ADAPTER?: string;

  // SSO — both must point at the same allenlabs-auth deployment. Sign-in
  // happens at AUTH_WEB_URL/sign-in; PM exchanges codes and verifies JWTs
  // against AUTH_API_URL.
  AUTH_WEB_URL: string;       // e.g. https://auth.allen.company
  AUTH_API_URL: string;       // e.g. https://auth-api.allen.company

  // secrets — only PUBLIC_BASE_URL is still needed for /auth/login to
  // build a callback URL the auth-web worker can redirect back to.
  PUBLIC_BASE_URL: string;

  // OpenTelemetry → Grafana LGTM.  Three gates in front of the collector:
  //   1. WAF custom rule on the zone requires `Authorization: Bearer …`.
  //   2. Cloudflare Access policy requires the service token headers.
  //   3. The OTLP collector itself.
  // Wrangler secrets: OTEL_BEARER_TOKEN, OTEL_ACCESS_ID, OTEL_ACCESS_SECRET.
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // Notion gateway — PM no longer talks to Notion directly.  Every
  // Notion API call is proxied through the central gateway at
  // NOTION_GATEWAY_URL, with HMAC-SHA256 signatures derived from
  // NOTION_GATEWAY_SECRET (matching the row in
  // `notion_gateway.app_clients` keyed by NOTION_GATEWAY_CLIENT_ID).
  // Push all three via `wrangler secret put` on this worker.
  NOTION_GATEWAY_URL: string;
  NOTION_GATEWAY_CLIENT_ID: string;
  NOTION_GATEWAY_SECRET: string;

  // PM ↔ auth-api org/team bridge.  PM maps each project to a Better Auth team
  // inside org `allenlabs` and manages per-project collaborators via the
  // HMAC-signed /sso/org/* endpoints on auth-api (AUTH_API_URL).  The shared
  // secret is pushed via `wrangler secret put PM_ORG_HMAC_SECRET` and must
  // match the value set on the auth-api worker.  Client id is the X-Client-Id
  // header value the auth side expects (default "pm").
  PM_ORG_HMAC_SECRET: string;
  PM_ORG_HMAC_CLIENT_ID: string;
}
