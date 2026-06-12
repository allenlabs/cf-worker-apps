// Inbound webhook from the notion-gateway.
//
// When a connected Notion page changes, the gateway POSTs a translated
// payload to PM's `app_clients.webhook_url` (configured in the gateway
// admin UI to point at `/api/notion-webhook` on this worker).  The body
// shape is documented in `apps/notion-gateway/workers/web/app/server/webhook.ts`:
//
//   {
//     event: string,                   // e.g. 'page.updated' | 'page.deleted'
//     app_resource: string,            // e.g. 'project/42'
//     app_record: string,              // e.g. 'issue/137'
//     fields: Record<string, primitive>,   // inverse-mapped Notion props
//     notion_page_id: string,
//     notion_event_id: string,
//   }
//
// Headers (gateway → PM):
//   X-Client-Id: 'gateway'
//   X-Timestamp: <ms>
//   X-Signature: base64(HMAC-SHA256(secret, `${ts}\n${body}`))
//
// PM verifies the signature with its own `NOTION_GATEWAY_SECRET` (same
// secret both sides use — the gateway signs outbound; PM signs inbound).

import { eq } from 'drizzle-orm';
import type { DB } from '@allenlabs/pm-core/db/client';
import { issues } from '@allenlabs/pm-core/db/schema';
import type { Env } from '@allenlabs/pm-core/lib/env';
import type { CurrentUser } from '@allenlabs/pm-core/server/auth';
import { updateIssueImpl } from './issues';
import { sign } from './notion-gateway-client';

export const MAX_SKEW_MS = 5 * 60 * 1000;

export interface WebhookHeaders {
  clientId: string | null;
  timestamp: string | null;
  signature: string | null;
}

export interface WebhookContext {
  /**
   * The "system" user used to author webhook-sourced journal/activity
   * rows.  Falls back to user id 1 (typically the admin seeded in
   * `0002_seed.sql`) when no system user is configured.  Callers may
   * pass an explicit row to short-circuit the lookup.
   */
  systemUser: CurrentUser;
}

export interface VerifyOutcome {
  ok: true;
  timestamp: number;
}
export interface VerifyError {
  ok: false;
  status: 401;
  message: string;
}

/**
 * Verify the gateway-signed envelope.  Pure so the test suite can drive
 * every branch without HTTP plumbing.
 */
export async function verifyWebhookImpl(
  env: Pick<Env, 'NOTION_GATEWAY_SECRET'>,
  rawBody: string,
  headers: WebhookHeaders,
  now: number = Date.now(),
): Promise<VerifyOutcome | VerifyError> {
  if (headers.clientId !== 'gateway') {
    return { ok: false, status: 401, message: 'bad client id' };
  }
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 401, message: 'missing timestamp' };
  }
  if (Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, message: 'stale timestamp' };
  }
  if (!headers.signature) {
    return { ok: false, status: 401, message: 'missing signature' };
  }
  const expected = await sign(env.NOTION_GATEWAY_SECRET, ts, rawBody);
  if (expected !== headers.signature) {
    return { ok: false, status: 401, message: 'bad signature' };
  }
  return { ok: true, timestamp: ts };
}

// ---------- Field translation ----------
//
// The gateway sends us a `fields` map keyed by PM field names (subject,
// status, tracker, …).  Update-issue impl expects FK ids on most of
// these.  We resolve the fk-lookups here so the journal entries record
// proper attribute changes instead of free-text mismatches.

import {
  issueCategories,
  users,
  versions,
} from '@allenlabs/pm-core/db/schema';
import { getRefData } from '@allenlabs/pm-core/server/ref-data';

async function resolveByName<T extends { id: number; name: string }>(
  rows: T[],
  name: unknown,
): Promise<number | null> {
  if (typeof name !== 'string' || !name) return null;
  const lowered = name.toLowerCase();
  const hit = rows.find((r) => r.name.toLowerCase() === lowered);
  return hit?.id ?? null;
}

/**
 * Translate the gateway's `fields` map back into the `changes` patch the
 * PM updateIssueImpl accepts (FK ids, not labels).  Anything the gateway
 * didn't include is left out of the patch — null means "explicit clear",
 * undefined / missing means "no change".
 */
export async function translateFieldsImpl(
  db: DB,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const changes: Record<string, unknown> = {};
  if ('subject' in fields && typeof fields.subject === 'string') {
    changes.subject = fields.subject;
  }
  if ('description' in fields && typeof fields.description === 'string') {
    changes.description = fields.description;
  }
  if ('status' in fields) {
    const { statuses } = await getRefData(db);
    changes.statusId = await resolveByName(statuses, fields.status);
  }
  if ('tracker' in fields) {
    const { trackers: trk } = await getRefData(db);
    changes.trackerId = await resolveByName(trk, fields.tracker);
  }
  if ('priority' in fields) {
    const { priorities } = await getRefData(db);
    changes.priorityId = await resolveByName(priorities, fields.priority);
  }
  if ('assignedTo' in fields) {
    const v = fields.assignedTo;
    if (typeof v === 'string' && v) {
      const u = await db.query.users.findFirst({ where: eq(users.email, v) });
      changes.assignedToId = u?.id ?? null;
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
      const u = await db.query.users.findFirst({ where: eq(users.email, v[0]) });
      changes.assignedToId = u?.id ?? null;
    } else {
      changes.assignedToId = null;
    }
  }
  if ('category' in fields) {
    const rows = await db.select().from(issueCategories);
    changes.categoryId = await resolveByName(rows, fields.category);
  }
  if ('fixedVersion' in fields) {
    const rows = await db.select().from(versions);
    changes.fixedVersionId = await resolveByName(rows, fields.fixedVersion);
  }
  if ('dueDate' in fields) {
    changes.dueDate = typeof fields.dueDate === 'string' ? fields.dueDate : null;
  }
  if ('startDate' in fields) {
    changes.startDate = typeof fields.startDate === 'string' ? fields.startDate : null;
  }
  if ('estimatedHours' in fields) {
    changes.estimatedHours =
      typeof fields.estimatedHours === 'number' ? fields.estimatedHours : null;
  }
  if ('doneRatio' in fields && typeof fields.doneRatio === 'number') {
    changes.doneRatio = fields.doneRatio;
  }
  return changes;
}

// ---------- Top-level webhook dispatch ----------

export interface WebhookBody {
  event: string;
  app_resource: string;
  app_record: string;
  fields?: Record<string, unknown>;
}

export interface DispatchOutcome {
  status: number;
  body: string;
}

export async function dispatchWebhookImpl(
  db: DB,
  body: WebhookBody,
  ctx: WebhookContext,
): Promise<DispatchOutcome> {
  // Parse `app_record` -> issue id; tolerate noise so a malformed event
  // doesn't 500 — we just acknowledge and drop.
  const match = /^issue\/(\d+)$/.exec(body.app_record ?? '');
  if (!match) {
    return { status: 200, body: '{"ok":true,"skip":"unknown record"}' };
  }
  const issueId = Number(match[1]);
  /* v8 ignore next 3 — the regex already enforces digits, so
     Number(match[1]) is always a finite integer; this guard exists for
     belt-and-braces only. */
  if (!Number.isFinite(issueId)) {
    return { status: 200, body: '{"ok":true,"skip":"bad id"}' };
  }

  // Make sure the issue still exists.
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) {
    return { status: 200, body: '{"ok":true,"skip":"missing issue"}' };
  }

  if (body.event === 'page.updated') {
    const changes = await translateFieldsImpl(db, body.fields ?? {});
    if (Object.keys(changes).length === 0) {
      return { status: 200, body: '{"ok":true,"skip":"no changes"}' };
    }
    await updateIssueImpl(
      db,
      ctx.systemUser,
      { id: issueId, notes: '', changes },
      { notionOrigin: true },
    );
    return { status: 200, body: '{"ok":true,"updated":true}' };
  }

  if (body.event === 'page.deleted') {
    // v1: log only.  A future migration will give PM a "closed by notion"
    // status; until then we acknowledge so the gateway stops retrying.
    return { status: 200, body: '{"ok":true,"skip":"page.deleted ignored"}' };
  }

  return { status: 200, body: '{"ok":true,"skip":"unknown event"}' };
}
