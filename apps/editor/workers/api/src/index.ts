// API worker entrypoint. Hono + single-secret HMAC middleware + the /v1
// router. Wrapped in @microlabs/otel-cf-workers so every fetch is a root span.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import { v1Router } from './handlers/router';
import type { AppBindings } from './context';
import type { Env } from './lib/env';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'editor-api' }));

// Everything under /v1/* is HMAC-gated (single shared EDITOR_HMAC_SECRET).
app.use('/v1/*', hmacMiddleware());
app.route('/v1', v1Router);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
