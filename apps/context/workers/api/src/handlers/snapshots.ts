import { Hono } from 'hono';
import { z } from 'zod';
import {
  deleteSnapshotImpl,
  getSnapshotImpl,
  listSnapshotsImpl,
  restoreSnapshotImpl,
  saveSchema,
  saveSnapshotImpl,
} from '../../../web/app/server/context';
import type { AppBindings } from '../context';

// POST   /v1/save
// GET    /v1/list?limit=20
// GET    /v1/:id
// POST   /v1/:id/restore
// DELETE /v1/:id
//
// Verified by the HMAC middleware; reads the validated payload from
// c.var.rawBody (already consumed by the middleware), parses against the
// shared schemas, and writes to `context.*` under the api_clients row's
// `user_id`.

export const snapshotsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseIdParam(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

snapshotsRouter.post('/save', async (c) => {
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

  const created = await saveSnapshotImpl(db, client.userId, result.data);
  return c.json(
    {
      id: created.id,
      name: created.name,
      createdAt: created.createdAt.toISOString(),
    },
    201,
  );
});

snapshotsRouter.get('/list', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const limitParam = c.req.query('limit');
  let limit = 20;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: 'invalid limit' }, 400);
    }
    limit = parsed;
  }
  const snapshots = await listSnapshotsImpl(db, client.userId, limit);
  return c.json({ snapshots }, 200);
});

snapshotsRouter.get('/:id', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdParam(c.req.param('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const snap = await getSnapshotImpl(db, client.userId, id);
  if (!snap) return c.json({ error: 'not found' }, 404);
  return c.json(snap, 200);
});

snapshotsRouter.post('/:id/restore', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdParam(c.req.param('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const snap = await restoreSnapshotImpl(db, client.userId, id);
  if (!snap) return c.json({ error: 'not found' }, 404);
  return c.json(snap, 200);
});

snapshotsRouter.delete('/:id', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdParam(c.req.param('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const ok = await deleteSnapshotImpl(db, client.userId, id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: id }, 200);
});
