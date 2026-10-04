// Cron-triggered worker that deletes attachment rows + their R2 objects when
// they're older than ATTACHMENT_TTL_DAYS and orphaned (i.e. the container
// issue / wiki page / journal has been deleted).
//
// Runs daily — see workers/cleanup/wrangler.toml.  Designed to be safe to
// re-run; uses CLEANUP_MAX_ROWS to bound a single invocation.
//
// Wrapped in `@microlabs/otel-cf-workers` so each scheduled invocation
// becomes a root span exported via OTLP/HTTP to Grafana LGTM. The SDK's
// `Trigger` union includes `ScheduledController`, so `instrument()` covers
// the scheduled handler natively alongside the optional manual-fetch one.
//
// The pure cleanup logic lives in `./runCleanup` so unit tests can import
// it without pulling in the otel SDK (which imports `cloudflare:workers` —
// not resolvable in the plain-node Vitest project).

import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { runCleanup, type CleanupEnv } from './runCleanup';

export { runCleanup };

interface Env extends CleanupEnv {
  // OpenTelemetry → Grafana LGTM via Cloudflare Access service token.
  // Set via `wrangler secret put OTEL_ACCESS_ID` / `OTEL_ACCESS_SECRET`
  // (use `--config workers/cleanup/wrangler.toml`).
  OTEL_ACCESS_ID: string;
  OTEL_ACCESS_SECRET: string;
  OTEL_BEARER_TOKEN: string;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const r = await runCleanup(env);
        console.log(
          `[pm-cleanup] scanned=${r.scanned} deleted=${r.deleted} freedBytes=${r.freedBytes} duration=${r.durationMs}ms`,
        );
      })(),
    );
  },

  // Optional fetch handler so you can poke the worker manually via
  // `curl https://pm-cleanup.<your-subdomain>.workers.dev/run`.  The route is
  // unauthenticated so consider locking it behind a secret in production.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      const result = await runCleanup(env);
      return Response.json(result);
    }
    return new Response('pm-cleanup worker — POST /run to invoke manually', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'pm-cleanup', version: '0.1.0' },
  exporter: {
    url: 'https://lgtm-otlp.allenlabs.org/v1/traces',
    headers: {
      // Three gates in front of LGTM: WAF custom rule (Bearer), Cloudflare
      // Access policy (service token), and the OTLP collector itself.
      authorization: `Bearer ${env.OTEL_BEARER_TOKEN}`,
      'cf-access-client-id': env.OTEL_ACCESS_ID,
      'cf-access-client-secret': env.OTEL_ACCESS_SECRET,
    },
  },
});

export default instrument(handler, otelConfig);
