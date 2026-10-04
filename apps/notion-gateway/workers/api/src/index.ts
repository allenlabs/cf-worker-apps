// API worker entrypoint.  Hono app + HMAC middleware + per-resource
// routers.  Wrapped in `@microlabs/otel-cf-workers` so every incoming
// fetch becomes a root span exported to Grafana LGTM.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import type { AppBindings } from './context';
import type { Env } from './env';
import { workspacesRouter } from './handlers/workspaces';
import { connectionsRouter } from './handlers/connections';
import { databasesRouter } from './handlers/databases';
import { pagesRouter } from './handlers/pages';
import { oauthRouter } from './handlers/oauth';

const app = new Hono<AppBindings>();

// Health check stays public so monitoring can hit it without a secret.
app.get('/health', (c) => c.json({ ok: true, service: 'notion-gateway-api' }));

// Everything under /v1/* is HMAC-gated.
app.use('/v1/*', hmacMiddleware());
app.route('/v1/workspaces', workspacesRouter);
app.route('/v1/connections', connectionsRouter);
app.route('/v1/databases', databasesRouter);
app.route('/v1/pages', pagesRouter);
app.route('/v1/oauth', oauthRouter);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
