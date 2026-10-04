/// <reference types="vite/client" />
//
// TanStack Start 1.168 single-call API.  The plugin auto-discovers
// `getRouter` from app/router.tsx so we don't pass createRouter here.
//
// Cloudflare passes the env binding as fetch's 2nd argument, but TanStack
// Start's request handler signature is (request, requestOpts) and it doesn't
// forward env down to route server handlers in 1.168.  As a workaround we
// stash env on globalThis at the entrypoint and read it via getEnv() helpers
// in auth-runtime.server.ts.  Single-threaded JS per isolate makes this
// race-safe.
//
// The whole worker is wrapped in `@microlabs/otel-cf-workers` so every
// incoming fetch becomes a root span exported via OTLP/HTTP to Grafana LGTM.
// `instrument()` only wraps the outer handler — the env-on-globalThis stash
// inside the fetch body still runs because the SDK calls our `fetch` as-is
// from within its trace context.
import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';
import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { Env } from '@allenlabs/pm-core/lib/env';

const handler = createStartHandler(defaultStreamHandler);

const worker = {
  async fetch(request, env, ctx): Promise<Response> {
    (globalThis as { __env__?: Env }).__env__ = env;
    const res = await handler(request, { context: { cloudflare: { env, ctx } } as unknown as Record<string, unknown> });
    // Prevent browsers from caching stale SSR HTML that references bundle hashes
    // that no longer exist after a new deploy.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) {
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  },
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'pm-web', version: '0.1.0' },
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

export default instrument(worker, otelConfig);
