import { Hono } from 'hono';
import { z } from 'zod';
import {
  dismissNudgeImpl,
  getActiveNudgeImpl,
  replyNudgeImpl,
} from '../../../web/app/server/concierge';
import { processNudgeForUserImpl } from '../../../web/app/server/pipeline';
import type { AppBindings } from '../context';

// POST   /v1/event                 — cross-app trigger
// GET    /v1/active                — today's loader: most recent unopened nudge
// POST   /v1/nudges/:id/dismiss    — mark dismissed
// POST   /v1/nudges/:id/reply      — capture a user reply

export const eventRouter = new Hono<AppBindings>();

const EventBody = z.object({
  // The cross-app event slug — informational, fed verbatim to the LLM.
  kind: z.string().min(1).max(64),
  // Subject user.  If absent we fall back to the api_clients row's user_id
  // (so the `cli` row works without specifying).
  user_id: z.number().int().positive().optional(),
  // Free-form reference for the LLM (issue id, focus session id, …).
  ref: z.string().max(200).optional(),
  // Free-form context blob the calling app wants to surface to the LLM.
  context: z.string().max(2000).optional(),
});

function jsonOrEmpty(raw: string): unknown {
  /* v8 ignore next — every caller below first runs through the HMAC
     middleware which signs+verifies a non-empty body; the empty-string
     branch is defensive against direct unit-test calls that bypass
     middleware. */
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseIdParam(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

eventRouter.post('/event', async (c) => {
  const raw = c.get('rawBody');
  const client = c.get('apiClient');
  const db = c.get('db');

  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = EventBody.safeParse(parsed);
  if (!result.success) {
    return c.json(
      { error: 'validation', issues: z.treeifyError(result.error) },
      422,
    );
  }
  const userId = result.data.user_id ?? client.userId;
  const triggerParts: string[] = [
    `Cross-app event from "${client.clientId}": ${result.data.kind}.`,
  ];
  if (result.data.ref) triggerParts.push(`ref=${result.data.ref}.`);
  if (result.data.context) triggerParts.push(result.data.context);
  const trigger = triggerParts.join(' ');

  const pipeline = await processNudgeForUserImpl(c.env, db, userId, {
    trigger,
    channels: ['push', 'today'],
  });
  if (pipeline.status === 'sent') {
    return c.json(
      {
        status: 'sent',
        nudge: pipeline.nudge,
        pushed: Boolean(pipeline.pushed),
      },
      201,
    );
  }
  return c.json(
    {
      status: pipeline.status,
      /* v8 ignore next — the pipeline always sets `reason` when status !=
         'sent' (skipped-gate sets one of disabled/quiet-hours/cadence;
         skipped-llm sets no-question); the ?? null fallback is defensive. */
      reason: pipeline.reason ?? null,
    },
    200,
  );
});

eventRouter.get('/active', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const userIdParam = c.req.query('user_id');
  let userId = client.userId;
  if (userIdParam !== undefined) {
    const parsed = Number(userIdParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: 'invalid user_id' }, 400);
    }
    userId = parsed;
  }
  const nudge = await getActiveNudgeImpl(db, userId);
  return c.json({ nudge }, 200);
});

eventRouter.post('/nudges/:id/dismiss', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const id = parseIdParam(c.req.param('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  const ok = await dismissNudgeImpl(db, client.userId, id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ dismissed: id }, 200);
});

const ReplyBody = z.object({
  reply: z.string().min(1).max(4000),
});

eventRouter.post('/nudges/:id/reply', async (c) => {
  const client = c.get('apiClient');
  const db = c.get('db');
  const raw = c.get('rawBody');
  const id = parseIdParam(c.req.param('id'));
  if (id == null) return c.json({ error: 'invalid id' }, 400);
  let parsed: unknown;
  try {
    parsed = jsonOrEmpty(raw);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = ReplyBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation' }, 422);
  }
  const ok = await replyNudgeImpl(db, client.userId, id, result.data.reply);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ replied: id }, 200);
});
