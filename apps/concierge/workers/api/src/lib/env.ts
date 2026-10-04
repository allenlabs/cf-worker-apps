// Bindings + env vars/secrets for the concierge API worker.

export interface Env {
  HYPERDRIVE: Hyperdrive;

  APP_NAME: string;
  PUBLIC_BASE_URL: string;
  INBOX_API_URL: string;

  // OpenTelemetry → Grafana LGTM.
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;

  // OpenAI-compatible LLM endpoint (for /v1/event-driven nudges).
  //
  // TODO(litellm): the user runs a local LiteLLM at 127.0.0.1:4000; once
  // it's exposed via a cloudflared tunnel (e.g. https://llm.allen.company/v1),
  // rotate LLM_BASE_URL in place — no code change needed because the LLM
  // client is plain `fetch` against an OpenAI-compatible /chat/completions
  // endpoint.
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL?: string;

  // Outbound push delivery (POSTs to inbox-api which owns the VAPID transport).
  // Optional — if unset, push channel is skipped.
  INBOX_HMAC_CLIENT_ID?: string;
  INBOX_HMAC_SECRET?: string;
}
