import { Hono } from 'hono';
import { z } from 'zod';
import {
  deleteItemImpl,
  markDoneImpl,
  nextItemImpl,
  saveItemImpl,
  saveSchema,
  skipItemImpl,
} from '../../../web/app/server/read-later';
import type { AppBindings } from '../context';

// POST   /v1/save     {url, title?, tags?[], source?}
// GET    /v1/next     ?freeMinutes=15
// POST   /v1/done     {id}
// POST   /v1/skip     {id}
// POST   /v1/delete   {id}
//
// Verified by the HMAC middleware; reads the validated payload from
// c.var.rawBody (already consumed by the middleware), parses against the
// shared schemas, and writes to `read_later.*` under the api_clients row's
// `user_id`.

export const itemsRouter = new Hono<AppBindings>();

const IdBody = z.object({ id: z.number().int().positive() });

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

itemsRouter.post('/save', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = saveSchema.safeParse(parsed);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      422,
    );
  }

  // Inline reader-mode extraction.  Use the worker's `fetch` binding so
  // outbound calls are observable in OTel.
  const created = await saveItemImpl(
    db,
    client.userId,
    { ...result.data, source: result.data.source ?? 'api' },
    new Date(),
    { fetch: globalThis.fetch },
  );
  return c.json(
    {
      id: created.id,
      url: created.url,
      title: created.title,
      estimatedMinutes: created.estimatedMinutes,
      savedAt: created.savedAt.toISOString(),
    },
    201,
  );
});

itemsRouter.get('/next', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const freeRaw = c.req.query('freeMinutes');
  let free: number | null = null;
  if (freeRaw !== undefined) {
    const n = Number(freeRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return c.json({ error: 'invalid freeMinutes' }, 400);
    }
    free = n;
  }
  const item = await nextItemImpl(db, client.userId, free);
  if (!item) return c.json({ item: null }, 200);
  return c.json({ item }, 200);
});

itemsRouter.post('/done', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = IdBody.safeParse(parsed);
  if (!result.success) return c.json({ error: 'validation' }, 422);
  const ok = await markDoneImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ done: result.data.id }, 200);
});

itemsRouter.post('/skip', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = IdBody.safeParse(parsed);
  if (!result.success) return c.json({ error: 'validation' }, 422);
  const ok = await skipItemImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ skipped: result.data.id }, 200);
});

itemsRouter.post('/delete', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = IdBody.safeParse(parsed);
  if (!result.success) return c.json({ error: 'validation' }, 422);
  const ok = await deleteItemImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: result.data.id }, 200);
});
