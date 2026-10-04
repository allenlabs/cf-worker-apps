import { Hono } from 'hono';
import { z } from 'zod';
import {
  deleteEntryImpl,
  getEntryImpl,
  saveSchema,
  saveEntryImpl,
  searchEntriesImpl,
} from '../../../web/app/server/solved';
import type { AppBindings } from '../context';

// POST   /v1/save     {title, body, tags?, source?, source_ref?, source_url?} → 201 {id}
// GET    /v1/search?q=...                                                      → 200 {hits[]}
// GET    /v1/get?id=...                                                        → 200 {entry}
// POST   /v1/delete   {id}                                                     → 200 {deleted:id}

export const entriesRouter = new Hono<AppBindings>();

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

// Spec-aligned wire shape: accept snake_case `source_ref`/`source_url` over
// the HMAC wire (curl/CLI ergonomics), pre-process into the camelCase
// `saveSchema` shape before validating.  Single zod chokepoint → single 422
// branch.
const wireToImpl = z.preprocess((raw) => {
  if (raw == null || typeof raw !== 'object') return raw;
  const w = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...w };
  if ('source_ref' in w) {
    out.sourceRef = w.source_ref;
    delete out.source_ref;
  }
  if ('source_url' in w) {
    out.sourceUrl = w.source_url;
    delete out.source_url;
  }
  return out;
}, saveSchema);

entriesRouter.post('/save', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = wireToImpl.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }

  const created = await saveEntryImpl(db, client.userId, {
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

entriesRouter.get('/search', async (c) => {
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
  const hits = await searchEntriesImpl(db, client.userId, q, limit);
  return c.json({ hits }, 200);
});

entriesRouter.get('/get', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdQuery(c.req.query('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const entry = await getEntryImpl(db, client.userId, id);
  if (!entry) return c.json({ error: 'not found' }, 404);
  return c.json(entry, 200);
});

const deleteBodySchema = z.object({ id: z.number().int().positive() });

entriesRouter.post('/delete', async (c) => {
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
  const ok = await deleteEntryImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: result.data.id }, 200);
});
