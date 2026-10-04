/// <reference types="vite/client" />
//
// TanStack Start 1.168 single-call API.  See PM's server.tsx for the long
// rationale on the env-on-globalThis stash + OTel wrapping.
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
    // Prevent browsers from caching stale SSR HTML that references bundle
    // hashes that no longer exist after a new deploy.
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
  service: { name: 'inbox-web', version: '0.1.0' },
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
