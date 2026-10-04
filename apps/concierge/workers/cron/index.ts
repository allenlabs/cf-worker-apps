// Cron-triggered worker that loops over enabled users, asks the LLM to
// compose ONE short ADHD-aware question per user (when allowed by quiet
// hours + cadence), inserts a row into concierge.nudges, and best-effort
// fans out a push notification via inbox-api.
//
// Runs every 30 minutes — see workers/cron/wrangler.toml.
//
// Wrapped in `@microlabs/otel-cf-workers` so each scheduled invocation
// becomes a root span exported via OTLP/HTTP to Grafana LGTM.  The pure
// logic lives in `./runCron` so unit tests can import it without pulling
// in the otel SDK (which imports `cloudflare:workers` — not resolvable in
// the plain-node Vitest project).

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
    connection: { search_path: 'concierge, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const r = await runCron(env, makeDb);
        console.log(
          `[concierge-cron] scanned=${r.scanned} sent=${r.sent} skipped=${r.skipped} errors=${r.errors} duration=${r.durationMs}ms`,
        );
      })(),
    );
  },

  // Optional fetch handler so you can poke the worker manually via
  // `curl -X POST https://concierge-cron.<your-subdomain>.workers.dev/run`.
  // Unauthenticated — fine for personal use; lock behind a secret in production.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      const result = await runCron(env, makeDb);
      return Response.json(result);
    }
    return new Response('concierge-cron worker — POST /run to invoke manually', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'concierge-cron', version: '0.1.0' },
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
