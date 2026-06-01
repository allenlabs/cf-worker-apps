// Cloudflare bindings + env vars/secrets available to the editor-web worker.
//
// Locally these come from wrangler (.dev.vars); in production from
// wrangler.toml [vars] + `wrangler secret put`.

export interface Env {
  ASSETS: Fetcher;

  // vars (from wrangler.toml [vars])
  APP_NAME: string;

  // SSO — both must point at the same allenlabs-auth deployment. Sign-in
  // happens at AUTH_WEB_URL/sign-in; editor exchanges codes and verifies JWTs
  // against AUTH_API_URL.
  AUTH_WEB_URL: string; // e.g. https://auth.allen.company
  AUTH_API_URL: string; // e.g. https://auth-api.allen.company

  // Needed so /auth/login can build a callback URL the auth-web worker can
  // redirect back to.
  PUBLIC_BASE_URL: string;

  // Backend (editor-api) base URL.
  EDITOR_API_URL: string; // e.g. https://editor-api.allenlabs.org

  // OpenTelemetry → Grafana LGTM. Wrangler secrets:
  //   OTEL_BEARER_TOKEN, OTEL_ACCESS_ID, OTEL_ACCESS_SECRET.
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // Shared HMAC secret used to sign requests to editor-api. Same value as the
  // EDITOR_HMAC_SECRET set on the editor-api worker. Secret:
  //   wrangler secret put EDITOR_HMAC_SECRET
  EDITOR_HMAC_SECRET: string;
}
