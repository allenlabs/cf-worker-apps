// Bindings + env vars/secrets for the editor API worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  // R2 bucket for uploaded images (served publicly via GET /files/*).
  FILES: R2Bucket;

  APP_NAME: string;

  // Real-time collab backend (allenlabs-collab Durable Object). The API
  // worker mints short-lived, room-scoped tokens for it on /v1/collab-token.
  COLLAB_URL: string; // e.g. wss://allenlabs-collab.allenlim.workers.dev/editor

  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // Secrets (set via `wrangler secret put` — never hardcode):
  //   EDITOR_HMAC_SECRET  — shared with the editor-web worker; gates /v1/*.
  //   COLLAB_HMAC_SECRET  — MUST equal the allenlabs-collab worker's secret;
  //                         used to sign room tokens it will verify.
  EDITOR_HMAC_SECRET: string;
  COLLAB_HMAC_SECRET: string;
}
