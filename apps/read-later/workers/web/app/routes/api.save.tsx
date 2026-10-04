import { createFileRoute } from '@tanstack/react-router';
import { saveSchema, saveItemImpl } from '~/server/read-later';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/save
 *
 * Cookie-authenticated save endpoint used by the in-browser UI / bookmarklet.
 * HMAC traffic (CLI, third-party automation) goes to
 * read-later-api.allenlabs.org instead; the impl is shared.
 */
export const Route = createFileRoute('/api/save')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke tests; impl coverage
         lives in tests/server/read-later.test.ts. */
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
        const created = await saveItemImpl(
          db,
          me.id,
          { ...parsed.data, source: parsed.data.source ?? 'web' },
          new Date(),
          { fetch: globalThis.fetch },
        );
        return new Response(
          JSON.stringify({
            id: created.id,
            url: created.url,
            title: created.title,
            estimatedMinutes: created.estimatedMinutes,
            savedAt: created.savedAt.toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
      /* v8 ignore stop */
    },
  },
});
