// Bindings + env vars/secrets for the API worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  // vars (from wrangler.toml [vars])
  APP_NAME: string;
  PUBLIC_BASE_URL: string;
  NOTION_OAUTH_REDIRECT_URI: string;

  // secrets — set via `wrangler secret put …`
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  WORKSPACE_TOKEN_KEY: string;     // 32-byte b64 AES-GCM key material

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}
