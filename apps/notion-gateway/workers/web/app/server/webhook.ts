// Notion webhook receiver.
//
// Notion's webhook lifecycle has two distinct shapes:
//
//   1. Verification handshake.  POST body `{ "verification_token": "<T>" }`.
//      Notion ALSO sends `X-Notion-Signature: sha256=HMAC(body, T)` —
//      the signature is computed using the very token being registered,
//      which lets us authenticate the request without prior shared
//      state.  We verify that, then persist `T` with status='pending'
//      and surface it in the admin UI; the operator pastes it back into
//      Notion's form to complete registration.  (Empirically discovered
//      via wrangler tail: Notion's docs initially suggested handshakes
//      were unsigned, but the actual product sends `X-Notion-Signature`
//      from request 1.)
//
//   2. Operational events.  Subsequent POSTs include
//      `X-Notion-Signature: sha256=<hex>` where <hex> is the
//      hex-encoded HMAC-SHA256 of the raw body, keyed by the
//      verification token we stored.  Multiple tokens can be active
//      (e.g. while a stale registration is being rotated out); we try
//      each one in order until one verifies.
//
// On a verified event we look up `page_links.page_id`, translate the
// Notion-side changes into PM-shaped fields via `getInverseMapping`,
// and POST the result to the consumer's registered `webhook_url`.

import { eq } from 'drizzle-orm';
import {
  appClients,
  connections,
  pageLinks,
  webhookSubscriptions,
} from '@shared/db/schema';
import type { DB } from '@shared/db/client';
import { signRequest } from '@shared/crypto';
import { getInverseMapping } from '@shared/mapping';
import { PM_FIELDS } from '@shared/types';

const enc = new TextEncoder();

// Reject events whose body-timestamp is more than this many ms in the
// past — Notion includes a `timestamp` ISO string in every payload so
// replay protection is straightforward.
export const MAX_EVENT_AGE_MS = 5 * 60 * 1000;

export interface NotionWebhookEvent {
  id: string;
  timestamp: string;
  workspace_id?: string;
  subscription_id?: string;
  integration_id?: string;
  type: string;
  entity: { id: string; type: string };
  data?: Record<string, unknown>;
}

export interface WebhookResult {
  status: number;
  body: string;
  /** True when the handler queued an outbound fanout POST. */
  fanned: boolean;
  /** Token row that verified this event (if any) — useful for tests. */
  verifiedSubscriptionId?: number;
}

export interface OutboundDeps {
  fetcher?: typeof fetch;
  /** Override `Date.now()` in tests. */
  now?: () => number;
}

// ---------- helpers ----------

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return hexEncode(new Uint8Array(sig));
}

/**
 * Strip an optional `sha256=` prefix the way the X-Notion-Signature
 * header is conventionally formatted.
 */
function parseSignatureHeader(raw: string | null): string | null {
  /* v8 ignore next — caller short-circuits before passing null. */
  if (!raw) return null;
  const eq = raw.indexOf('=');
  if (eq < 0) return raw;
  const scheme = raw.slice(0, eq).toLowerCase();
  if (scheme !== 'sha256') return null;
  return raw.slice(eq + 1);
}

// ---------- main entrypoint ----------

export interface HandleWebhookInput {
  rawBody: string;
  signatureHeader: string | null;
}

/**
 * Pure-impl webhook receiver — the route shell wires `c.executionCtx` +
 * env in and returns `{status, body}` to Hono.  Returning `fanned=true`
 * means the caller MUST `waitUntil(...)` the returned promise; we don't
 * touch executionCtx here so the impl stays unit-testable.
 */
export async function handleWebhookImpl(
  db: DB,
  input: HandleWebhookInput,
  deps: OutboundDeps = {},
): Promise<WebhookResult & { fanout?: () => Promise<void> }> {
  // Parse the body once.  Both branches need the parsed shape.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: '{"error":"bad json"}', fanned: false };
  }

  // ---------- (1) verification handshake ----------
  // Detected by `verification_token` being a string in the body — Notion
  // sends the signature header on these too, so we can't use the header's
  // presence to discriminate operational events from handshakes.
  if (typeof parsed.verification_token === 'string') {
    const token = parsed.verification_token;
    // If a signature header is present, it must HMAC-match using the
    // body's own token — this proves the request is from Notion before
    // we trust the token enough to store it.
    if (input.signatureHeader) {
      const expected = parseSignatureHeader(input.signatureHeader);
      if (!expected) {
        return { status: 401, body: '{"error":"bad signature scheme"}', fanned: false };
      }
      const candidate = await hmacHex(token, input.rawBody);
      if (!constantTimeEqual(candidate, expected)) {
        return { status: 401, body: '{"error":"bad verification signature"}', fanned: false };
      }
    }
    await db.insert(webhookSubscriptions).values({ verificationToken: token });
    return { status: 200, body: '', fanned: false };
  }

  // ---------- (2) signed operational event ----------
  if (!input.signatureHeader) {
    return { status: 401, body: '{"error":"missing signature"}', fanned: false };
  }

  const expected = parseSignatureHeader(input.signatureHeader);
  if (!expected) {
    return { status: 401, body: '{"error":"bad signature scheme"}', fanned: false };
  }

  const subs = await db
    .select()
    .from(webhookSubscriptions)
    .orderBy(webhookSubscriptions.id);

  let matched: typeof webhookSubscriptions.$inferSelect | undefined;
  for (const row of subs) {
    const candidate = await hmacHex(row.verificationToken, input.rawBody);
    if (constantTimeEqual(candidate, expected)) {
      matched = row;
      break;
    }
  }
  if (!matched) {
    return { status: 401, body: '{"error":"bad signature"}', fanned: false };
  }

  // Lift any first-time-verifying token from 'pending' to 'verified'.
  if (matched.status === 'pending') {
    await db
      .update(webhookSubscriptions)
      .set({ status: 'verified', verifiedAt: new Date() })
      .where(eq(webhookSubscriptions.id, matched.id));
  }

  // Parse the operational event payload after signature has verified —
  // never trust the body shape before then.
  const event = parsed as unknown as NotionWebhookEvent;
  if (!event || !event.entity || typeof event.entity.id !== 'string') {
    return {
      status: 200,
      body: '{"ok":true,"skip":"missing entity"}',
      fanned: false,
      verifiedSubscriptionId: matched.id,
    };
  }

  // Replay protection.
  const eventTs = Date.parse(typeof event.timestamp === 'string' ? event.timestamp : '');
  const now = (deps.now ?? Date.now)();
  if (!Number.isFinite(eventTs) || now - eventTs > MAX_EVENT_AGE_MS) {
    return {
      status: 401,
      body: '{"error":"stale event"}',
      fanned: false,
      verifiedSubscriptionId: matched.id,
    };
  }

  // Find every `page_links` row matching this entity id (a single page
  // may be mirrored from multiple apps; we fan out to each).
  const links = await db.select().from(pageLinks).where(eq(pageLinks.pageId, event.entity.id));
  if (links.length === 0) {
    return {
      status: 200,
      body: '{"ok":true,"skip":"unknown page"}',
      fanned: false,
      verifiedSubscriptionId: matched.id,
    };
  }

  // Build the outbound payload(s).
  const outbound: Array<{
    appClient: typeof appClients.$inferSelect;
    body: string;
  }> = [];
  for (const link of links) {
    const conn = await db.query.connections.findFirst({
      where: eq(connections.id, link.connectionId),
    });
    /* v8 ignore next — FK guarantees connection exists. */
    if (!conn) continue;
    const appClient = await db.query.appClients.findFirst({
      where: eq(appClients.id, conn.appClientId),
    });
    /* v8 ignore next — FK guarantees app_clients row exists. */
    if (!appClient) continue;
    if (!appClient.webhookUrl) continue; // no fanout target

    const notionProperties: Record<string, unknown> =
      (event.data as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};

    const fields = getInverseMapping(PM_FIELDS, conn.mapping, notionProperties);

    const payload = {
      event: event.type,
      app_resource: conn.appResource,
      app_record: link.appRecord,
      fields,
      notion_page_id: event.entity.id,
      notion_event_id: event.id,
    };
    outbound.push({ appClient, body: JSON.stringify(payload) });
  }

  if (outbound.length === 0) {
    return {
      status: 200,
      body: '{"ok":true,"skip":"no webhook_url"}',
      fanned: false,
      verifiedSubscriptionId: matched.id,
    };
  }

  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const fanout = async () => {
    await Promise.all(
      outbound.map(async ({ appClient, body }) => {
        const timestamp = (deps.now ?? Date.now)();
        const sig = await signRequest(appClient.hmacSecret, body, timestamp);
        // The webhook_url MUST exist here — outbound is filtered above.
        const url = appClient.webhookUrl as string;
        await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': 'gateway',
            'X-Timestamp': String(timestamp),
            'X-Signature': sig,
          },
          body,
        });
      }),
    );
  };

  return {
    status: 200,
    body: JSON.stringify({ ok: true, fanned: outbound.length }),
    fanned: true,
    verifiedSubscriptionId: matched.id,
    fanout,
  };
}

// ---------- admin helpers ----------

export interface WebhookAdminView {
  pending: Array<{ id: number; verificationToken: string; createdAt: string }>;
  verifiedCount: number;
}

export async function listWebhookAdminImpl(db: DB): Promise<WebhookAdminView> {
  const rows = await db.select().from(webhookSubscriptions).orderBy(webhookSubscriptions.id);
  const pending: WebhookAdminView['pending'] = [];
  let verifiedCount = 0;
  for (const r of rows) {
    if (r.status === 'pending') {
      pending.push({
        id: r.id,
        verificationToken: r.verificationToken,
        createdAt: r.createdAt.toISOString(),
      });
    } else if (r.status === 'verified') {
      verifiedCount++;
    }
  }
  return { pending, verifiedCount };
}

export async function updateWebhookUrlImpl(
  db: DB,
  appClientId: number,
  webhookUrl: string | null,
): Promise<{ ok: true }> {
  await db
    .update(appClients)
    .set({ webhookUrl: webhookUrl && webhookUrl.length > 0 ? webhookUrl : null })
    .where(eq(appClients.id, appClientId));
  return { ok: true };
}

