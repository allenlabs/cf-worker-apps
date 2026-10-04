import { Hono } from 'hono';
import { z } from 'zod';
import {
  getCurrentIntentImpl,
  listHistoryImpl,
  setIntentImpl,
  setIntentSchema,
} from '../../../web/app/server/intent';
import type { AppBindings } from '../context';

// POST /v1/set       {text}  → upsert single row + history
// GET  /v1/current
// GET  /v1/history?limit=50

export const intentRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

intentRouter.post('/set', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = setIntentSchema.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const entry = await setIntentImpl(db, client.userId, result.data);
  return c.json({ current: entry }, 201);
});

intentRouter.get('/current', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const current = await getCurrentIntentImpl(db, client.userId);
  return c.json({ current }, 200);
});

intentRouter.get('/history', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: 'invalid limit' }, 400);
  }
  const history = await listHistoryImpl(db, client.userId, limit);
  return c.json({ history }, 200);
});
