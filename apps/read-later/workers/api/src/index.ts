// API worker entrypoint.  Hono + HMAC middleware + per-resource routers.
// Wrapped in @microlabs/otel-cf-workers so every fetch becomes a root span.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import type { AppBindings } from './context';
import type { Env } from './lib/env';
import { itemsRouter } from './handlers/items';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'read-later-api' }));

// Everything under /v1/* is HMAC-gated.  Items router exposes /save, /next,
// /done, /skip, /delete under /v1.
app.use('/v1/*', hmacMiddleware());
app.route('/v1', itemsRouter);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
