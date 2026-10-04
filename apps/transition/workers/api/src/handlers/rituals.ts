import { Hono } from 'hono';
import { z } from 'zod';
import {
  listRecentImpl,
  saveRitualImpl,
  saveRitualSchema,
} from '../../../web/app/server/transition';
import type { AppBindings } from '../context';

// POST /v1/save        {leaving_at, next_step, might_forget, target?}
// GET  /v1/recent?limit=20

export const ritualsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

ritualsRouter.post('/save', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = saveRitualSchema.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const ritual = await saveRitualImpl(db, client.userId, result.data);
  return c.json({ ritual }, 201);
});

ritualsRouter.get('/recent', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: 'invalid limit' }, 400);
  }
  const rituals = await listRecentImpl(db, client.userId, limit);
  return c.json({ rituals }, 200);
});
