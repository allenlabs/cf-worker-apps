import { Hono } from 'hono';
import { z } from 'zod';
import {
  createReminderImpl,
  createSchema,
  deleteReminderImpl,
  dismissReminderImpl,
  listUpcomingImpl,
  snoozeReminderImpl,
} from '../../../web/app/server/nudge';
import type { AppBindings } from '../context';

// POST   /v1/create    {text, fire_at|relative_seconds, recurrence?, tags?}
// GET    /v1/upcoming                                       → 200 {reminders[]}
// POST   /v1/dismiss   {id}                                 → 200 {dismissed:id}
// POST   /v1/snooze    {id, minutes}                        → 200 {reminder}
// POST   /v1/delete    {id}                                 → 200 {deleted:id}

export const remindersRouter = new Hono<AppBindings>();

function jsonOrEmpty(raw: string): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

const idBody = z.object({ id: z.number().int().positive() });
const snoozeBody = z.object({
  id: z.number().int().positive(),
  minutes: z.number().int().min(1).max(60 * 24 * 30),
});

// Accept snake_case fire_at + relative_seconds + tags from the API; the impl
// expects camelCase.  Convert here so the public contract stays HTTP-ish.
const apiCreateBody = z
  .object({
    text: z.string(),
    fire_at: z.string().datetime().optional(),
    fireAt: z.string().datetime().optional(),
    relative_seconds: z.number().int().positive().optional(),
    relativeSeconds: z.number().int().positive().optional(),
    recurrence: z.string().optional().nullable(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
  })
  .transform((v) => ({
    text: v.text,
    fireAt: v.fireAt ?? v.fire_at,
    relativeSeconds: v.relativeSeconds ?? v.relative_seconds,
    recurrence: v.recurrence,
    tags: v.tags,
    source: v.source,
  }));

remindersRouter.post('/create', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const stage1 = apiCreateBody.safeParse(parsed);
  if (!stage1.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(stage1.error) }, 422);
  }
  const result = createSchema.safeParse(stage1.data);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const created = await createReminderImpl(db, client.userId, {
    ...result.data,
    source: result.data.source ?? client.clientId,
  });
  return c.json(created, 201);
});

remindersRouter.get('/upcoming', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const withinParam = c.req.query('within');
  let within = 60 * 60 * 24;
  if (withinParam !== undefined) {
    const n = Number(withinParam);
    if (!Number.isFinite(n) || n <= 0) {
      return c.json({ error: 'invalid within' }, 400);
    }
    within = Math.min(n, 60 * 60 * 24 * 30);
  }
  const list = await listUpcomingImpl(db, client.userId, within);
  return c.json({ reminders: list }, 200);
});

remindersRouter.post('/dismiss', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = idBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const ok = await dismissReminderImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ dismissed: result.data.id }, 200);
});

remindersRouter.post('/snooze', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = snoozeBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const reminder = await snoozeReminderImpl(db, client.userId, result.data.id, result.data.minutes);
  if (!reminder) return c.json({ error: 'not found' }, 404);
  return c.json({ reminder }, 200);
});

remindersRouter.post('/delete', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = idBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const ok = await deleteReminderImpl(db, client.userId, result.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: result.data.id }, 200);
});
