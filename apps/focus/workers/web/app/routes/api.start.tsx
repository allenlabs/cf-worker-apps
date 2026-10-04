import { createFileRoute } from '@tanstack/react-router';
import { startSchema, startSessionImpl } from '~/server/focus';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/start
 *
 * Cookie-authenticated session-start endpoint used by the web UI and the
 * in-browser extension's "start a session on this tab" action.  HMAC
 * traffic (CLI, third-party automation) goes to focus-api.allenlabs.org
 * instead; the impl is shared.
 */
export const Route = createFileRoute('/api/start')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke tests; impl coverage
         lives in tests/server/focus.test.ts. */
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
        const parsed = startSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const created = await startSessionImpl(db, me.id, parsed.data);
        return new Response(
          JSON.stringify({
            id: created.id,
            startedAt: created.startedAt.toISOString(),
            endsAt: created.endsAt.toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
      /* v8 ignore stop */
    },
  },
});
