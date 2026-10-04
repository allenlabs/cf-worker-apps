import { createFileRoute } from '@tanstack/react-router';
import { distractImpl, distractSchema } from '~/server/focus';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/distract
 *
 * Cookie-authenticated wobble logger.  Body: `{ sessionId, label,
 * details? }`.  Does NOT end the session — the user wanted to acknowledge
 * a drift, not punish themselves for it.
 */
export const Route = createFileRoute('/api/distract')({
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
        const parsed = distractSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const created = await distractImpl(db, me.id, parsed.data);
        if (!created) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ id: created.id, notedAt: created.notedAt.toISOString() }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
      /* v8 ignore stop */
    },
  },
});
