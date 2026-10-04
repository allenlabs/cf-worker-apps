import { createFileRoute } from '@tanstack/react-router';
import {
  setPreferencesImpl,
  setPreferencesSchema,
  type SetPreferencesInput,
} from '~/server/concierge';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { hhmmToMinutes } from '~/lib/format';

/**
 * POST /api/preferences — cookie-authenticated update of the user's nudge
 * preferences from the admin UI.  Accepts ISO times ("22:30") or raw
 * minutes; quietStart/quietEnd may be null to clear.
 */
export const Route = createFileRoute('/api/preferences')({
  server: {
    handlers: {
      /* v8 ignore start — exercised by deploy smoke; impl coverage lives in
         tests/server/concierge.test.ts. */
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

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        // Browsers send time inputs as "HH:MM" strings; coerce to minutes.
        if (typeof body.quietStart === 'string') {
          body.quietStart = hhmmToMinutes(body.quietStart);
        }
        if (typeof body.quietEnd === 'string') {
          body.quietEnd = hhmmToMinutes(body.quietEnd);
        }
        const parsed = setPreferencesSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(JSON.stringify({ error: 'validation' }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        }
        const next = await setPreferencesImpl(
          db,
          me.id,
          parsed.data as SetPreferencesInput,
        );
        return Response.json(next);
      },
      /* v8 ignore stop */
    },
  },
});
