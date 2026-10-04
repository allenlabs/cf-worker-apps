import { Hono } from 'hono';
import { z } from 'zod';
import {
  deleteSnippetImpl,
  getSnippetImpl,
  saveSchema,
  saveSnippetImpl,
  searchSnippetsImpl,
} from '../../../web/app/server/stash';
import type { AppBindings } from '../context';

// POST   /v1/save     {body, title?, tags?, language?}   → 201 {id}
// GET    /v1/search?q=...&limit=                          → 200 {hits[]}
// GET    /v1/get?id=...                                   → 200 {snippet}
// POST   /v1/delete   {id}                                → 200 {deleted:id}
//
// Verified by the HMAC middleware; reads the validated payload from
// c.var.rawBody (already consumed by the middleware), parses against the
// shared schemas, and writes to `stash.*` under the api_clients row's
// `user_id`.

export const snippetsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseIdQuery(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

snippetsRouter.post('/save', async (c) => {
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

  const created = await saveSnippetImpl(db, client.userId, {
    ...result.data,
    source: result.data.source ?? client.clientId,
  });
  return c.json(
    {
      id: created.id,
      title: created.title,
      createdAt: created.createdAt.toISOString(),
    },
    201,
  );
});

snippetsRouter.get('/search', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const q = c.req.query('q');
  if (!q || q.length === 0) {
    return c.json({ error: 'missing q' }, 400);
  }
  if (q.length > 400) {
    return c.json({ error: 'q too long' }, 400);
  }
  const limitParam = c.req.query('limit');
  let limit = 50;
  if (limitParam !== undefined) {
    const n = Number(limitParam);
    if (!Number.isFinite(n) || n <= 0) {
      return c.json({ error: 'invalid limit' }, 400);
    }
    limit = n;
  }
  const hits = await searchSnippetsImpl(db, client.userId, q, limit);
  return c.json({ hits }, 200);
});

snippetsRouter.get('/get', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdQuery(c.req.query('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const snippet = await getSnippetImpl(db, client.userId, id);
  if (!snippet) return c.json({ error: 'not found' }, 404);
  return c.json(snippet, 200);
});

const deleteBodySchema = z.object({ id: z.number().int().positive() });

snippetsRouter.post('/delete', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = deleteBodySchema.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const ok = await deleteSnippetImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: result.data.id }, 200);
});
