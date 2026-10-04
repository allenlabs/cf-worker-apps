/// <reference types="vite/client" />
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
    return await handler(request, {
      context: { cloudflare: { env, ctx } } as unknown as Record<string, unknown>,
    });
  },
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'solved-web', version: '0.1.0' },
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
