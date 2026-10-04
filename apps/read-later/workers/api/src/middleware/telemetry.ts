// OTel wrapper for the API worker.  Same three-gate pattern (WAF Bearer +
// Cloudflare Access service token + OTLP collector) as PM / inbox / focus /
// context.

import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { Env } from '../lib/env';

export const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'read-later-api', version: '0.1.0' },
  exporter: {
    url: 'https://lgtm-otlp.allenlabs.org/v1/traces',
    headers: {
      authorization: `Bearer ${env.OTEL_BEARER_TOKEN}`,
      'cf-access-client-id': env.OTEL_ACCESS_ID,
      'cf-access-client-secret': env.OTEL_ACCESS_SECRET,
    },
  },
});

export { instrument };
