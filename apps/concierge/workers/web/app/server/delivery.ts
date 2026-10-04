// Delivery helpers — push goes through the inbox-api (which owns the user's
// push_subscriptions + VAPID transport); today is a pull from the today
// dashboard's loader (concierge just inserts the nudge row).  Email is a
// TODO — see PLAN.md Phase E.

import { signRequest } from '~/lib/hmac';

export interface DeliverPushEnv {
  INBOX_API_URL?: string;
  INBOX_HMAC_CLIENT_ID?: string;
  INBOX_HMAC_SECRET?: string;
}

export interface DeliverPushInput {
  userId: number;
  title: string;
  body: string;
  /** Deep-link the user opens when they tap the notification. */
  url: string;
  /** Collapse tag so multiple nudges don't stack into a pile of bells. */
  tag?: string;
}

export interface DeliverPushResult {
  delivered: boolean;
  skipped?: 'not-configured';
  statusCode?: number;
}

/**
 * POST a notification payload to inbox-api's internal delivery endpoint.
 *
 * inbox-api accepts an `X-Client-Id` / `X-Timestamp` / `X-Signature`
 * triple (same scheme as inbox.api_clients).  Concierge gets its own
 * api_clients row provisioned in inbox's DB and we sign with the
 * matching secret.
 *
 * Best-effort.  If the env doesn't carry the secret (e.g. dev), we no-op.
 */
export async function deliverPushImpl(
  env: DeliverPushEnv,
  input: DeliverPushInput,
  fetchFn: typeof fetch = fetch,
): Promise<DeliverPushResult> {
  if (!env.INBOX_API_URL || !env.INBOX_HMAC_SECRET || !env.INBOX_HMAC_CLIENT_ID) {
    return { delivered: false, skipped: 'not-configured' };
  }
  const body = JSON.stringify({
    userId: input.userId,
    title: input.title,
    body: input.body,
    url: input.url,
    tag: input.tag ?? 'concierge-nudge',
  });
  const ts = Date.now();
  const sig = await signRequest(env.INBOX_HMAC_SECRET, body, ts);
  const url = `${env.INBOX_API_URL.replace(/\/$/, '')}/v1/notify`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Client-Id': env.INBOX_HMAC_CLIENT_ID,
      'X-Timestamp': String(ts),
      'X-Signature': sig,
    },
    body,
  });
  return { delivered: res.ok, statusCode: res.status };
}
