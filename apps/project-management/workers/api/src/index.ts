// PM REST API worker. Plain Hono + HMAC middleware. Everything under /v1/* is
// HMAC-gated; handlers act on behalf of the api_clients row's user_id.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { issuesRouter } from './handlers/issues';
import type { AppBindings } from './context';
import type { Env } from './lib/env';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'pm-api' }));

app.use('/v1/*', hmacMiddleware());
app.route('/v1', issuesRouter);

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
