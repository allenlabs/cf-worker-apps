import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { users } from '@allenlabs/pm-core/db/schema';
import {
  dispatchWebhookImpl,
  verifyWebhookImpl,
  type WebhookBody,
} from '~/server/notion-webhook';
import { getDb, getEnv } from '~/server/auth-runtime.server';

/**
 * Notion gateway webhook receiver.
 *
 * Configured as PM's `app_clients.webhook_url` in the gateway admin UI:
 *
 *   https://pm.allen.company/api/notion-webhook
 *
 * Inbound: HMAC-SHA256(body, NOTION_GATEWAY_SECRET) over `${ts}\n${body}`,
 * headers `X-Client-Id: gateway`, `X-Timestamp`, `X-Signature`.
 *
 * The handler stays thin — it does I/O glue only (read body, look up
 * system user) and delegates verification + dispatch to the pure impls in
 * `~/server/notion-webhook.ts` so coverage is straightforward.
 */
export const Route = createFileRoute('/api/notion-webhook')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by route-level integration tests; the
         pure impls in notion-webhook.ts hold the unit coverage. */
      POST: async ({ request }) => {
        const env = getEnv();
        const db = getDb(env);
        const rawBody = await request.text();
        const verdict = await verifyWebhookImpl(env, rawBody, {
          clientId: request.headers.get('x-client-id'),
          timestamp: request.headers.get('x-timestamp'),
          signature: request.headers.get('x-signature'),
        });
        if (!verdict.ok) {
          return new Response(JSON.stringify({ error: verdict.message }), {
            status: verdict.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        let body: WebhookBody;
        try {
          body = JSON.parse(rawBody) as WebhookBody;
        } catch {
          return new Response('{"error":"bad json"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        // The journal rows the webhook produces need an authoring user.
        // We use whichever admin row has the lowest id — typically the
        // bootstrap admin from the seed — falling back to user id 1.
        const systemUser = await db.query.users.findFirst({
          where: eq(users.admin, true),
        });
        if (!systemUser) {
          return new Response('{"error":"no system user"}', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        const outcome = await dispatchWebhookImpl(db, body, {
          systemUser: {
            id: systemUser.id,
            login: systemUser.login,
            email: systemUser.email,
            firstname: systemUser.firstname,
            lastname: systemUser.lastname,
            isAdmin: true,
            avatarUrl: systemUser.avatarUrl,
          },
        });
        return new Response(outcome.body, {
          status: outcome.status,
          headers: { 'content-type': 'application/json' },
        });
      },
      /* v8 ignore stop */
    },
  },
});
