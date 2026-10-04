// Shared types between the ingest and relay workers.

export interface Subscriber {
  id: string;
  endpoint: string;
  headerName?: string; // e.g. "X-Webhook-Signature"
  headerValue?: string;
}

export interface WebhookEvent {
  // Stable id assigned by the ingest worker; used for de-dupe + idempotency.
  id: string;
  // Source identifier (e.g. "github", "stripe"); free-form.
  source: string;
  // Original method + path that was hit on the ingest worker.
  method: string;
  path: string;
  // Original headers (filtered) and body bytes (base64).  We persist bytes so
  // signature checks on the receiving end still work.
  headers: Record<string, string>;
  bodyBase64: string;
  receivedAt: number;
}

export interface DeliveryAttempt {
  subscriberId: string;
  attempt: number;
  status: number | null;
  ok: boolean;
  error?: string;
  durationMs: number;
}

// Single Workflow step input — used by the relay workflow defined in
// workers/relay/index.ts.
export interface RelayJob {
  event: WebhookEvent;
  subscribers: Subscriber[];
  // Initial backoff in ms.  Doubles on each retry up to maxAttempts.
  initialBackoffMs: number;
  maxAttempts: number;
}
