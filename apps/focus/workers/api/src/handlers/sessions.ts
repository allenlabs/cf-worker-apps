import { Hono } from 'hono';
import { z } from 'zod';
import {
  distractImpl,
  distractSchema,
  endSchema,
  endSessionImpl,
  getActiveSessionImpl,
  startSchema,
  startSessionImpl,
} from '../../../web/app/server/focus';
import type { AppBindings } from '../context';

// POST /v1/start
// POST /v1/end
// POST /v1/distract
// GET  /v1/active
//
// Verified by the HMAC middleware; reads the validated payload from
// c.var.rawBody (already consumed by the middleware), parses against the
// shared schemas, and writes to `focus.*` under the api_clients row's
// `user_id`.

export const sessionsRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

sessionsRouter.post('/start', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = startSchema.safeParse(parsed);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      422,
    );
  }

  const created = await startSessionImpl(db, client.userId, result.data);
  return c.json(
    {
      id: created.id,
      startedAt: created.startedAt.toISOString(),
      endsAt: created.endsAt.toISOString(),
    },
    201,
  );
});

sessionsRouter.post('/end', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = endSchema.safeParse(parsed);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      422,
    );
  }

  const updated = await endSessionImpl(db, client.userId, result.data);
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json(updated, 200);
});

sessionsRouter.post('/distract', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = distractSchema.safeParse(parsed);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      422,
    );
  }

  const created = await distractImpl(db, client.userId, result.data);
  if (!created) return c.json({ error: 'not found' }, 404);
  return c.json({ id: created.id, notedAt: created.notedAt.toISOString() }, 201);
});

sessionsRouter.get('/active', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const active = await getActiveSessionImpl(db, client.userId);
  return c.json({ active }, 200);
});
