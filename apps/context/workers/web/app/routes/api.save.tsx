import { createFileRoute } from '@tanstack/react-router';
import { saveSchema, saveSnapshotImpl } from '~/server/context';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/save
 *
 * Cookie-authenticated save endpoint used by the in-browser UI.  HMAC
 * traffic (CLI, third-party automation) goes to context-api.allenlabs.org
 * instead; the impl is shared.
 */
export const Route = createFileRoute('/api/save')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke tests; impl coverage
         lives in tests/server/context.test.ts. */
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
        const parsed = saveSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const created = await saveSnapshotImpl(db, me.id, parsed.data);
        return new Response(
          JSON.stringify({
            id: created.id,
            name: created.name,
            createdAt: created.createdAt.toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
      /* v8 ignore stop */
    },
  },
});
