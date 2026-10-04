// Ingest worker.  Accepts arbitrary webhooks at /hooks/:source, persists the
// raw payload + filtered headers, then pushes a `RelayJob` to the `EVENTS`
// queue.  The relay worker is the consumer and runs the Workflow per event.

import { Hono } from 'hono';
import type { RelayJob, Subscriber, WebhookEvent } from '../../shared/types';

interface Env {
  EVENTS: Queue<RelayJob>;
  SUBSCRIBERS: KVNamespace;
  INGEST_SECRET: string;
  INITIAL_BACKOFF_MS: string;
  MAX_ATTEMPTS: string;
}

const SAFE_HEADERS = new Set([
  'content-type',
  'user-agent',
  'x-github-event',
  'x-github-delivery',
  'x-hub-signature-256',
  'stripe-signature',
  'x-shopify-topic',
]);

function filterHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    if (SAFE_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  });
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export async function loadSubscribers(
  kv: KVNamespace,
  source: string,
): Promise<Subscriber[]> {
  const raw = await kv.get(`subscribers:${source}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Subscriber[]) : [];
  } catch {
    return [];
  }
}

export async function buildJob(opts: {
  request: Request;
  source: string;
  env: Env;
}): Promise<{ event: WebhookEvent; job: RelayJob; subscribers: Subscriber[] }> {
  const bodyBytes = new Uint8Array(await opts.request.arrayBuffer());
  const event: WebhookEvent = {
    id: crypto.randomUUID(),
    source: opts.source,
    method: opts.request.method,
    path: new URL(opts.request.url).pathname,
    headers: filterHeaders(opts.request),
    bodyBase64: bytesToBase64(bodyBytes),
    receivedAt: Date.now(),
  };
  const subscribers = await loadSubscribers(opts.env.SUBSCRIBERS, opts.source);
  const job: RelayJob = {
    event,
    subscribers,
    initialBackoffMs: Number(opts.env.INITIAL_BACKOFF_MS || '1000'),
    maxAttempts: Number(opts.env.MAX_ATTEMPTS || '5'),
  };
  return { event, job, subscribers };
}

const app = new Hono<{ Bindings: Env }>();

app.post('/hooks/:source', async (c) => {
  // Simple shared-secret gate (header `X-Ingest-Secret`) — bypassed when not
  // configured so local dev stays painless.
  if (c.env.INGEST_SECRET) {
    const provided = c.req.header('x-ingest-secret');
    if (provided !== c.env.INGEST_SECRET) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  const source = c.req.param('source');
  const { event, job, subscribers } = await buildJob({
    request: c.req.raw.clone(),
    source,
    env: c.env,
  });
  if (subscribers.length === 0) {
    return c.json({ accepted: false, reason: 'no subscribers', eventId: event.id }, 202);
  }
  await c.env.EVENTS.send(job);
  return c.json({ accepted: true, eventId: event.id, fanOut: subscribers.length }, 202);
});

app.get('/health', (c) => c.json({ ok: true }));

export default app;
