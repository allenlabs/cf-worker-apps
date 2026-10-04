// Items endpoints for the inbox API worker.
//
//   GET   /v1/items?status=unread       — list this client's items
//   PATCH /v1/items/:id    body={...}   — transition a single item
//
// Both routes assume the HMAC middleware has already populated
// `c.var.apiClient` (the row from `inbox.api_clients`) so we can scope
// every read / write to that client's `user_id`.  A forged item id from
// one user cannot mutate another user's row (the WHERE clause in the
// impls filters by user_id).

import { Hono } from 'hono';
import { z } from 'zod';
import {
  STATUSES,
  TRIAGE_ACTIONS,
  applyTriageImpl,
  listItemsImpl,
  setItemStatusImpl,
  type Status,
  type TriageAction,
} from '../../../web/app/server/inbox';
import type { AppBindings } from '../context';

export const itemsRouter = new Hono<AppBindings>();

// ---------- GET /v1/items ----------

const listQuerySchema = z.object({
  // 'unread' default lives in the impl, not here, so an empty query
  // string is fine.  'all' is a special marker for "everything except
  // dropped" (matches loadTriageImpl's behaviour).
  status: z.union([z.enum(STATUSES), z.literal('all')]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

itemsRouter.get('/', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');

  const parsed = listQuerySchema.safeParse({
    status: c.req.query('status'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(parsed.error) },
      400,
    );
  }

  const result = await listItemsImpl(db, client.userId, parsed.data);
  return c.json(result, 200);
});

// ---------- PATCH /v1/items/:id ----------
//
// Accepts either:
//   { action: TriageAction }     — what the CLI sends ('done', 'drop', ...)
//   { status: Status, snoozedUntil?: ISO8601 }
//
// The two shapes are mutually exclusive at the schema level; supporting
// both keeps the CLI working today while leaving room for richer
// (status + snoozedUntil) calls from future clients without versioning
// the endpoint.

const patchActionSchema = z.object({
  action: z.enum(TRIAGE_ACTIONS),
});

const patchStatusSchema = z.object({
  status: z.enum(STATUSES),
  snoozedUntil: z.string().datetime().optional(),
});

const patchBodySchema = z.union([patchActionSchema, patchStatusSchema]);

itemsRouter.patch('/:id', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  const idParam = c.req.param('id');
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }

  let parsedBody: unknown;
  try {
    parsedBody = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = patchBodySchema.safeParse(parsedBody);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      400,
    );
  }

  // Branch on body shape.  `'action' in result.data` narrows to the
  // action schema; otherwise it's the status schema.
  if ('action' in result.data) {
    const action: TriageAction = result.data.action;
    const updated = await applyTriageImpl(db, client.userId, { id, action });
    if (!updated) {
      return c.json({ error: 'not found' }, 403);
    }
    return c.json({ id: updated.id, status: updated.status }, 200);
  }

  const status: Status = result.data.status;
  const snoozedUntil = result.data.snoozedUntil
    ? new Date(result.data.snoozedUntil)
    : undefined;
  const updated = await setItemStatusImpl(db, client.userId, id, {
    status,
    snoozedUntil,
  });
  if (!updated) {
    return c.json({ error: 'not found' }, 403);
  }
  return c.json(
    {
      id: updated.id,
      status: updated.status,
      snoozedUntil:
        updated.snoozedUntil == null ? null : updated.snoozedUntil.toISOString(),
    },
    200,
  );
});
