import { Hono } from 'hono';
import { z } from 'zod';
import {
  checkinSchema,
  getTodayImpl,
  listRangeImpl,
  upsertCheckinImpl,
} from '../../../web/app/server/gentle';
import type { AppBindings } from '../context';

// POST /v1/checkin   {slept_ok?, meds?, ate?, moved?, talked?, note?, date?} → upsert
// GET  /v1/today
// GET  /v1/range?from=&to=

export const checkinsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

checkinsRouter.post('/checkin', async (c) => {
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
  const entry = await upsertCheckinImpl(db, client.userId, result.data);
  return c.json({ entry }, 201);
});

checkinsRouter.get('/today', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const entry = await getTodayImpl(db, client.userId);
  return c.json({ entry }, 200);
});

checkinsRouter.get('/range', async (c) => {
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
