// Bindings + env vars/secrets for the web worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  APP_NAME: string;
  AUTH_API_URL: string;          // e.g. https://auth-api.allen.company
  AUTH_WEB_URL: string;          // e.g. https://auth.allen.company
  PUBLIC_BASE_URL: string;
  NOTION_OAUTH_REDIRECT_URI: string;

  // secrets
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  WORKSPACE_TOKEN_KEY: string;

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}
