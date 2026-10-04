// Bindings + env vars/secrets for the context API worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  APP_NAME: string;
  PUBLIC_BASE_URL: string;

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}
