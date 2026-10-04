/// <reference types="vite/client" />
//
// TanStack Start single-call API. The plugin auto-discovers `getRouter` from
// app/router.tsx. Cloudflare's fetch passes env as the 2nd arg; we stash it on
// globalThis so getEnv() helpers can read it (single-threaded per isolate →
// race-safe). The worker is wrapped in @microlabs/otel-cf-workers.
import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';
import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { Env } from '~/lib/env';

const handler = createStartHandler(defaultStreamHandler);

const worker = {
  async fetch(request, env, ctx): Promise<Response> {
    (globalThis as { __env__?: Env }).__env__ = env;
    const res = await handler(request, {
      context: { cloudflare: { env, ctx } } as unknown as Record<string, unknown>,
    });
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
  service: { name: 'editor-web', version: '0.1.0' },
  exporter: {
    url: 'https://lgtm-otlp.allenlabs.org/v1/traces',
    headers: {
      authorization: `Bearer ${env.OTEL_BEARER_TOKEN}`,
      'cf-access-client-id': env.OTEL_ACCESS_ID,
      'cf-access-client-secret': env.OTEL_ACCESS_SECRET,
    },
  },
});

export default instrument(worker, otelConfig);
