import { createFileRoute } from '@tanstack/react-router';
import { processNudgeForUserImpl } from '~/server/pipeline';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';

/**
 * POST /api/trigger — manual "compose a nudge now" button on the admin UI.
 *
 * Bypasses cadence (so the user can verify the LLM round-trip without
 * waiting for the next cron tick) but still honours `enabled` + quiet hours
 * via the pipeline's gate.  To bypass everything, edit your preferences row.
 */
export const Route = createFileRoute('/api/trigger')({
  server: {
    handlers: {
      /* v8 ignore start — UI-side helper exercised by deploy smoke. */
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

        const result = await processNudgeForUserImpl(env, db, me.id, {
          trigger: 'Manual trigger from the admin UI.',
          channels: ['today'],
        });
        return Response.json(result);
      },
      /* v8 ignore stop */
    },
  },
});
