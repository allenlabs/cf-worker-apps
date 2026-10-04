// OTel wrapper for the API worker.  Follows the same three-gate pattern
// PM uses: WAF custom rule (Bearer), Cloudflare Access policy (service
// token), and the OTLP collector itself.

import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { Env } from '../env';

export const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'notion-gateway-api', version: '0.1.0' },
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
