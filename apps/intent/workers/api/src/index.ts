import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import type { AppBindings } from './context';
import type { Env } from './lib/env';
import { intentRouter } from './handlers/intent';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'intent-api' }));

app.use('/v1/*', hmacMiddleware());
app.route('/v1', intentRouter);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
