import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import type { AppBindings } from './context';
import type { Env } from './lib/env';
import { remindersRouter } from './handlers/reminders';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'nudge-api' }));

app.use('/v1/*', hmacMiddleware());
app.route('/v1', remindersRouter);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
