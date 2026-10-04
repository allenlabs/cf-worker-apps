import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { getPreferencesImpl, setPreferencesImpl } from '~/server/push';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * GET  /api/push/preferences        — returns the caller's preferences row (defaults if none).
 * POST /api/push/preferences        — body: { onCapture?, quietStart?, quietEnd? }
 *
 * Both routes are cookie-gated.  `quietStart`/`quietEnd` are minutes
 * from local midnight (0..1439) or `null` to disable; partial bodies
 * merge with existing values.
 */
const preferencesSchema = z.object({
  onCapture: z.boolean().optional(),
  quietStart: z.union([z.number().int().min(0).max(1439), z.null()]).optional(),
  quietEnd: z.union([z.number().int().min(0).max(1439), z.null()]).optional(),
});

export const Route = createFileRoute('/api/push/preferences')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke tests; impl coverage
         lives in tests/server/push.test.ts. */
      GET: async ({ request }) => {
        const env = getEnv();
        const cookie = request.headers.get('cookie');
        const token = readSessionToken(cookie);
        if (!token) return new Response('Unauthorized', { status: 401 });
        const payload = await verifySessionToken(env, token);
        if (!payload?.sub) return new Response('Unauthorized', { status: 401 });
        const db = getDb(env);
        const me = await findUserBySsoImpl(db, payload.sub);
        if (!me) return new Response('Unauthorized', { status: 401 });

        const prefs = await getPreferencesImpl(db, me.id);
        return new Response(JSON.stringify(prefs), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
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
        const parsed = preferencesSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: 'validation', issues: parsed.error.issues }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          );
        }
        const prefs = await setPreferencesImpl(db, me.id, parsed.data);
        return new Response(JSON.stringify(prefs), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      /* v8 ignore stop */
    },
  },
});
