import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import {
  registerSubscriptionImpl,
  removeSubscriptionImpl,
} from '~/server/push';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/push/subscribe
 *   body: { endpoint, keys: { p256dh, auth } }
 * DELETE /api/push/subscribe
 *   body: { endpoint }
 *
 * Cookie-authenticated.  The browser calls `PushManager.subscribe()` and
 * POSTs the result here.  We store one row per (user, endpoint); the
 * endpoint URL is the natural key (unique per device + browser + push
 * service).  Unsubscribe removes only the caller's row — endpoint is
 * scoped by user_id to prevent cross-user deletion.
 */
const subscribeSchema = z.object({
  endpoint: z.string().min(1).max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2000),
});

export const Route = createFileRoute('/api/push/subscribe')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke tests; impl coverage
         lives in tests/server/push.test.ts. */
      POST: async ({ request }) => {
        const env = getEnv();
        const cookie = request.headers.get('cookie');
        const token = readSessionToken(cookie);
        if (!token) return new Response('Unauthorized', { status: 401 });
        const payload = await verifySessionToken(env, token);
        if (!payload?.sub) return new Response('Unauthorized', { status: 401 });
        const db = getDb(env);
        const me = await findUserBySsoImpl(db, payload.sub);
        if (!me) return new Response('Unauthorized', { status: 401 });

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        const parsed = subscribeSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const userAgent = request.headers.get('user-agent');
        const r = await registerSubscriptionImpl(db, me.id, parsed.data, userAgent);
        return new Response(JSON.stringify({ ok: true, id: r.id }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      DELETE: async ({ request }) => {
        const env = getEnv();
        const cookie = request.headers.get('cookie');
        const token = readSessionToken(cookie);
        if (!token) return new Response('Unauthorized', { status: 401 });
        const payload = await verifySessionToken(env, token);
        if (!payload?.sub) return new Response('Unauthorized', { status: 401 });
        const db = getDb(env);
        const me = await findUserBySsoImpl(db, payload.sub);
        if (!me) return new Response('Unauthorized', { status: 401 });

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        const parsed = unsubscribeSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const r = await removeSubscriptionImpl(db, me.id, parsed.data.endpoint);
        return new Response(JSON.stringify({ ok: true, removed: r.removed }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      /* v8 ignore stop */
    },
  },
});
