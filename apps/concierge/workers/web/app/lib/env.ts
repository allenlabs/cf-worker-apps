// Cloudflare bindings + env vars/secrets for the concierge web worker.
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

  // SSO — both must point at the same allenlabs-auth deployment.
  AUTH_WEB_URL: string;       // e.g. https://auth.allen.company
  AUTH_API_URL: string;       // e.g. https://auth-api.allen.company

  // Used by /auth/login to build a callback URL.
  PUBLIC_BASE_URL: string;

  // OpenTelemetry → Grafana LGTM.  Three gates: WAF Bearer, CF Access service
  // token, then the OTLP collector itself.  Wrangler secrets.
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // OpenAI-compatible LLM endpoint, used by the admin UI's "Trigger one now"
  // button.  Same secrets as the cron worker.
  //
  // TODO(litellm): once the local LiteLLM at 127.0.0.1:4000 is exposed via
  // cloudflared tunnel (e.g. https://llm.allen.company/v1), rotate
  // LLM_BASE_URL in place — no code change needed because the LLM client is
  // plain `fetch` against an OpenAI-compatible /chat/completions endpoint.
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL?: string;

  // Optional push delivery via inbox-api.
  INBOX_API_URL?: string;
  INBOX_HMAC_CLIENT_ID?: string;
  INBOX_HMAC_SECRET?: string;
}
