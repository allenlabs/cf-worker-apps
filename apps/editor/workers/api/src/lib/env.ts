// Bindings + env vars/secrets for the editor API worker.

import type { WorkspaceDB } from '../do/workspace-db';

export interface Env {
  HYPERDRIVE: Hyperdrive;

  // R2 bucket for uploaded images (served publicly via GET /files/*).
  FILES: R2Bucket;

  // Datasource Step 2: per-workspace SQLite Durable Object backing NATIVE
  // databases (db_backend='native_do'). ADDITIVE — existing Postgres-backed
  // databases never touch this binding.
  WORKSPACE_DB: DurableObjectNamespace<WorkspaceDB>;

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

  // OPTIONAL LLM secrets for the AI assist route (/v1/ai). OpenAI-compatible
  // `/chat/completions` (same shape as concierge cron). When unset, /v1/ai
  // returns a 503 "AI not configured" — the route never crashes.
  //   wrangler secret put LLM_BASE_URL  --config workers/api/wrangler.toml
  //   wrangler secret put LLM_API_KEY   --config workers/api/wrangler.toml
  //   wrangler secret put LLM_MODEL     --config workers/api/wrangler.toml  (optional; defaults gpt-4o-mini)
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}
