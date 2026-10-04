export interface Env {
  // Suite-wide JWT revocation list lives in the auth D1 (allenlabs-auth-d1,
  // APAC). Each web worker binds it read+write; the `revoked_sessions` table
  // (apps/auth/migrations-d1/0007_revoked_sessions.sql) is shared across the
  // whole suite so a logout on one app blocks the JWT everywhere. Replaces
  // the per-app SESSION_KV namespaces that lived in Workers KV.
  AUTH_DB: D1Database;
  ASSETS: Fetcher;

  APP_NAME: string;

  AUTH_WEB_URL: string;
  AUTH_API_URL: string;
  PUBLIC_BASE_URL: string;

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}
