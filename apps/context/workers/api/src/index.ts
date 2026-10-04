// API worker entrypoint.  Hono + HMAC middleware + per-resource routers.
// Wrapped in @microlabs/otel-cf-workers so every fetch becomes a root span.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import type { AppBindings } from './context';
import type { Env } from './lib/env';
import { snapshotsRouter } from './handlers/snapshots';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'context-api' }));

// Everything under /v1/* is HMAC-gated.  Snapshots router exposes /save,
// /list, /:id, /:id/restore, /:id (DELETE) under /v1.
app.use('/v1/*', hmacMiddleware());
app.route('/v1', snapshotsRouter);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
