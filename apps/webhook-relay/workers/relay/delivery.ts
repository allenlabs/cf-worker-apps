// Pure delivery helpers — no cloudflare:workers imports, so they're
// safely unit-testable in Node.
import type {
  DeliveryAttempt,
  Subscriber,
  WebhookEvent,
} from '../../shared/types';

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deliverOnce(
  event: WebhookEvent,
  subscriber: Subscriber,
  attempt: number,
  userAgent: string,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryAttempt> {
  const t0 = Date.now();
  const headers: Record<string, string> = {
    ...event.headers,
    'user-agent': userAgent,
    'x-relay-attempt': String(attempt),
    'x-relay-event-id': event.id,
    'x-relay-source': event.source,
  };
  if (subscriber.headerName && subscriber.headerValue) {
    headers[subscriber.headerName.toLowerCase()] = subscriber.headerValue;
  }
  try {
    const res = await fetcher(subscriber.endpoint, {
      method: event.method || 'POST',
      headers,
      body: base64ToBytes(event.bodyBase64),
    });
    return {
      subscriberId: subscriber.id,
      attempt,
      status: res.status,
      ok: res.ok,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      subscriberId: subscriber.id,
      attempt,
      status: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}
