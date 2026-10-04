import { createFileRoute } from '@tanstack/react-router';
import { endSchema, endSessionImpl } from '~/server/focus';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/end
 *
 * Cookie-authenticated session-end endpoint.  Body: `{ sessionId,
 * endedReason, notes?, satisfaction? }`.  Same impl as the HMAC API
 * worker; the cookie variant is what the web UI and extension call.
 */
export const Route = createFileRoute('/api/end')({
  server: {
    handlers: {
      /* v8 ignore start — impl coverage lives in tests/server/focus.test.ts. */
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
        const parsed = endSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const updated = await endSessionImpl(db, me.id, parsed.data);
        if (!updated) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      /* v8 ignore stop */
    },
  },
});
