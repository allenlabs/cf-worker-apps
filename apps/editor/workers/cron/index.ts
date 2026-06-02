// Cron-triggered worker that fires due @date reminders. Every tick it selects
// reminders whose remind_at has passed (fired=false), inserts a kind=reminder
// notification for each owner, and marks them fired. The actual logic lives in
// the api handler `fireDueRemindersImpl` (unit-tested); this is a thin wrapper.
//
// Runs every 5 minutes — see workers/cron/wrangler.toml.

import { makeDb } from '../api/src/lib/db';
import { fireDueRemindersImpl } from '../api/src/handlers/notify';

interface Env {
  HYPERDRIVE: Hyperdrive;
  APP_NAME?: string;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const sql = makeDb(env);
        try {
          const fired = await fireDueRemindersImpl(sql, new Date().toISOString());
          console.log(`[editor-cron] reminders fired=${fired}`);
        } finally {
          await sql.end({ timeout: 5 });
        }
      })(),
    );
  },

  // Manual poke: `curl -X POST https://editor-cron.<subdomain>.workers.dev/run`.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      const sql = makeDb(env);
      try {
        const fired = await fireDueRemindersImpl(sql, new Date().toISOString());
        return Response.json({ fired });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    return new Response('editor-cron worker — POST /run to fire due reminders', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;

export default handler;
