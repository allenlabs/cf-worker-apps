// API worker entrypoint. Hono + single-secret HMAC middleware + the /v1
// router. Wrapped in @microlabs/otel-cf-workers so every fetch is a root span.

import { Hono } from 'hono';
import { hmacMiddleware } from './middleware/hmac';
import { instrument, otelConfig } from './middleware/telemetry';
import { v1Router } from './handlers/router';
import { keyFromPath } from './handlers/files';
import { publicPageImpl } from './handlers/collab';
import {
  formShareByTokenImpl,
  publicFormDefinitionImpl,
  submitFormImpl,
} from './handlers/forms';
import { dbBackendImpl } from './handlers/db';
import { makePostgresDataSource } from './datasource/postgres';
import { makeNativeDataSource } from './datasource/native';
import type { DataSource } from './datasource/types';
import { makeDb } from './lib/db';
import type { AppBindings } from './context';
import type { Env } from './lib/env';

// Datasource Step 2: the per-workspace SQLite Durable Object backing native
// databases. Re-exported from the worker entry so the runtime can instantiate
// the class named by the [[durable_objects.bindings]] + [[migrations]]
// new_sqlite_classes entry in wrangler.toml.
export { WorkspaceDB } from './do/workspace-db';

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

// PUBLIC form routes — registered BEFORE the /v1 HMAC gate so a signed-out
// visitor can fetch a shared form's schema and submit it. Gated NOT by HMAC but
// by an ENABLED `editor.form_shares` row keyed on the urlsafe :token. The GET
// returns SCHEMA ONLY (no row data); the POST validates against the token's
// form and creates ONE row with only the whitelisted fields.
//
// Both resolve the database's backend (postgres | native_do) so a native DB's
// form works the same. A bad/disabled token → 404 (formShareByTokenImpl only
// matches enabled shares).

/** Resolve the DataSource for a form share's database (PG or native DO). */
async function formDataSource(
  env: Env,
  sql: ReturnType<typeof makeDb>,
  databaseId: string,
): Promise<DataSource | null> {
  const info = await dbBackendImpl(sql, databaseId);
  if (!info) return null;
  if (info.backend === 'native_do') return makeNativeDataSource(env, info.workspaceId);
  return makePostgresDataSource(sql);
}

app.get('/public/form/:token', async (c) => {
  const token = c.req.param('token');
  const db = makeDb(c.env);
  const share = await formShareByTokenImpl(db, token);
  if (!share) return c.json({ error: 'not found' }, 404);
  const ds = await formDataSource(c.env, db, share.databaseId);
  if (!ds) return c.json({ error: 'not found' }, 404);
  const def = await publicFormDefinitionImpl(ds, share);
  if (!def) return c.json({ error: 'not found' }, 404);
  return c.json(def, 200);
});

app.post('/public/form/:token/submit', async (c) => {
  const token = c.req.param('token');
  // Size-guard the raw body BEFORE parsing (defense against a large anon POST).
  let body: unknown;
  try {
    const raw = await c.req.text();
    if (raw.length > 256 * 1024) return c.json({ error: 'payload too large' }, 413);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const answers =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ((body as { answers?: unknown }).answers ?? body)
      : {};
  const answerMap =
    answers && typeof answers === 'object' && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)
      : {};

  const db = makeDb(c.env);
  const share = await formShareByTokenImpl(db, token);
  if (!share) return c.json({ error: 'not found' }, 404);
  const ds = await formDataSource(c.env, db, share.databaseId);
  if (!ds) return c.json({ error: 'not found' }, 404);
  // Anonymous attribution — the row's owner is a synthetic "Form" author id.
  const outcome = await submitFormImpl(ds, share, answerMap, 'form-anonymous');
  if (!outcome.ok) {
    if (outcome.status === 400) return c.json({ error: 'validation', errors: outcome.errors }, 400);
    return c.json({ error: 'not found' }, outcome.status as 404);
  }
  return c.json({ ok: true }, 200);
});

// Everything under /v1/* is HMAC-gated (single shared EDITOR_HMAC_SECRET).
app.use('/v1/*', hmacMiddleware());
app.route('/v1', v1Router);

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default instrument(worker, otelConfig);
