import { Hono } from 'hono';
import { z } from 'zod';
import {
  createEventImpl,
  eventSchema,
  getRandomWinImpl,
  listRecentImpl,
} from '../../../web/app/server/dopamine';
import type { AppBindings } from '../context';

// POST /v1/event             {kind, title, source_ref?, body?, importance?, tags?[]}
// GET  /v1/recent?limit=50
// GET  /v1/random?since_days=90

export const eventsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

eventsRouter.post('/event', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = eventSchema.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const event = await createEventImpl(db, client.userId, result.data);
  return c.json({ event }, 201);
});

eventsRouter.get('/recent', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: 'invalid limit' }, 400);
  }
  const events = await listRecentImpl(db, client.userId, limit);
  return c.json({ events }, 200);
});

eventsRouter.get('/random', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const daysRaw = c.req.query('since_days');
  const days = daysRaw ? Number(daysRaw) : 90;
  if (!Number.isFinite(days) || days <= 0) {
    return c.json({ error: 'invalid since_days' }, 400);
  }
  const event = await getRandomWinImpl(db, client.userId, days);
  if (!event) return c.json({ event: null }, 200);
  return c.json({ event }, 200);
});
