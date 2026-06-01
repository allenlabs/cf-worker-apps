// API worker entrypoint. Hono + single-secret HMAC middleware + the /v1
// router. Wrapped in @microlabs/otel-cf-workers so every fetch is a root span.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import { v1Router } from './handlers/router';
import { keyFromPath } from './handlers/files';
import { publicPageImpl } from './handlers/collab';
import { makeDb } from './lib/db';
import type { AppBindings } from './context';
import type { Env } from './lib/env';

const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'editor-api' }));

// PUBLIC image serve — registered BEFORE the /v1 HMAC gate so <img src> works
// without a signature. Only serves keys under `editor/`.
app.get('/files/*', async (c) => {
  const key = keyFromPath(new URL(c.req.url).pathname);
  if (!key) return c.json({ error: 'not found' }, 404);
  const object = await c.env.FILES.get(key);
  if (!object) return c.json({ error: 'not found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
});

// PUBLIC read for shared pages — registered BEFORE the /v1 HMAC gate so the
// signed-out public share link works. Returns the page only when it exists and
// public=true (publicPageImpl enforces that); 404 otherwise. No user identity.
app.get('/public/page/:id', async (c) => {
  const id = c.req.param('id');
  const db = makeDb(c.env);
  const page = await publicPageImpl(db, id);
  if (!page) return c.json({ error: 'not found' }, 404);
  return c.json(page, 200);
});

// Everything under /v1/* is HMAC-gated (single shared EDITOR_HMAC_SECRET).
app.use('/v1/*', hmacMiddleware());
app.route('/v1', v1Router);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
