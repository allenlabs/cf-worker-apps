// OAuth start-token endpoint.
//
// A consumer app calls this to get a pre-signed URL it can redirect the
// user to.  We could have the consumer sign the URL itself (they have
// the secret), but exposing this as a documented API endpoint means
// future apps don't need to re-implement the signing scheme.
//
// The signature payload is `${app_client_id}\n${app_resource}\n${return_to}`
// — fixed-format so the /oauth/start route can re-derive it without
// extra metadata.

import { Hono } from 'hono';
import { z } from 'zod';
import { signRequest } from '@shared/crypto';
import type { AppBindings, AppClientContext } from '../context';

export const oauthStartTokenInput = z.object({
  app_resource: z.string().min(1),
  return_to: z.string().url(),
});
export type OAuthStartTokenInput = z.infer<typeof oauthStartTokenInput>;

export async function oauthStartTokenImpl(
  appClient: AppClientContext,
  publicBaseUrl: string,
  input: OAuthStartTokenInput,
): Promise<{ start_url: string }> {
  const payload = `${appClient.id}\n${input.app_resource}\n${input.return_to}`;
  // Reuse the request-signing helper; `signRequest(secret, body, timestamp)`
  // computes `HMAC(`${timestamp}\n${body}`)`.  Here we want
  // `HMAC(payload)`, so we pass timestamp='' and body=payload — the
  // resulting signed string is `\npayload`, which is deterministic and
  // re-verifiable from the /oauth/start route.
  const sig = await signRequest(appClient.hmacSecret, payload, 0);
  const base = publicBaseUrl.replace(/\/$/, '');
  const url = new URL(`${base}/oauth/start`);
  url.searchParams.set('app', appClient.clientId);
  url.searchParams.set('resource', input.app_resource);
  url.searchParams.set('return_to', input.return_to);
  url.searchParams.set('sig', sig);
  return { start_url: url.toString() };
}

/* v8 ignore start */
export const oauthRouter = new Hono<AppBindings>().post('/start-token', async (c) => {
  const input = oauthStartTokenInput.parse(JSON.parse(c.var.rawBody || '{}'));
  return c.json(await oauthStartTokenImpl(c.var.appClient, c.env.PUBLIC_BASE_URL, input));
});
/* v8 ignore stop */
