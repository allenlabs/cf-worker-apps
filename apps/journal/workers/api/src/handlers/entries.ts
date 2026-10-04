import { Hono } from 'hono';
import { z } from 'zod';
import {
  checkinSchema,
  getByDateImpl,
  getTodayImpl,
  listRangeImpl,
  statsImpl,
  upsertCheckinImpl,
} from '../../../web/app/server/journal';
import type { AppBindings } from '../context';

// POST /v1/checkin   {mood, energy, focus, mind?, blockers?, date?} → upsert
// GET  /v1/today
// GET  /v1/range?from&to
// GET  /v1/stats

export const entriesRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

entriesRouter.post('/checkin', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = checkinSchema.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const entry = await upsertCheckinImpl(db, client.userId, {
    ...result.data,
    source: result.data.source ?? client.clientId,
  });
  return c.json({ entry }, 201);
});

entriesRouter.get('/today', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const entry = await getTodayImpl(db, client.userId);
  return c.json({ entry }, 200);
});

entriesRouter.get('/range', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: 'invalid range — from + to (yyyy-mm-dd) required' }, 400);
  }
  if (to < from) {
    return c.json({ error: 'to must be >= from' }, 400);
  }
  const entries = await listRangeImpl(db, client.userId, from, to);
  return c.json({ entries }, 200);
});

entriesRouter.get('/stats', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const stats = await statsImpl(db, client.userId);
  return c.json(stats, 200);
});

entriesRouter.get('/entry', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const date = c.req.query('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid date' }, 400);
  }
  const entry = await getByDateImpl(db, client.userId, date);
  if (!entry) return c.json({ error: 'not found' }, 404);
  return c.json({ entry }, 200);
});
