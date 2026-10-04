import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../web/app/db/schema';
import type { DB } from '../web/app/db/client';
import { runCron, type CronEnv } from './runCron';

export { runCron };

interface Env extends CronEnv {
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}

function makeDb(env: { HYPERDRIVE: Hyperdrive }): DB {
  const raw = postgres(env.HYPERDRIVE.connectionString, {
    max: 4,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'nudge, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const r = await runCron(env, makeDb);
        console.log(
          `[nudge-cron] scanned=${r.scanned} delivered=${r.delivered} skipped=${r.skipped} errors=${r.errors} duration=${r.durationMs}ms`,
        );
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      const result = await runCron(env, makeDb);
      return Response.json(result);
    }
    return new Response('nudge-cron worker — POST /run to invoke manually', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'nudge-cron', version: '0.1.0' },
  exporter: {
    url: 'https://lgtm-otlp.allenlabs.org/v1/traces',
    headers: {
      authorization: `Bearer ${env.OTEL_BEARER_TOKEN}`,
      'cf-access-client-id': env.OTEL_ACCESS_ID,
      'cf-access-client-secret': env.OTEL_ACCESS_SECRET,
    },
  },
});

export default instrument(handler, otelConfig);
