// Bindings + env vars/secrets for the inbox API worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  APP_NAME: string;
  PUBLIC_BASE_URL: string;

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // Web Push (VAPID) — same trio as the inbox-web worker.  The API worker
  // also notifies on capture (CLI / extension), so it needs the signing
  // key locally to dispatch pushes without a worker-to-worker hop.
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}
