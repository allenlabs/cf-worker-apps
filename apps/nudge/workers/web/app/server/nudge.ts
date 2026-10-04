// Nudge impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).
// Re-exported from both the web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { reminders } from '~/db/schema';

const TEXT_MAX = 2000;

const RECURRENCE_RE = /^(daily|weekly|monthly|every:[0-9]+(s|m|h|d))$/;

export const createSchema = z
  .object({
    text: z.string().min(1).max(TEXT_MAX).refine((v) => v.trim().length > 0, {
      message: 'text is empty',
    }),
    fireAt: z.string().datetime().optional(),
    relativeSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
    recurrence: z.string().regex(RECURRENCE_RE).optional().nullable(),
    tags: z.array(z.string().min(1).max(64)).max(16).optional(),
    source: z.string().min(1).max(40).optional(),
  })
  .refine((v) => v.fireAt !== undefined || v.relativeSeconds !== undefined, {
    message: 'either fireAt or relativeSeconds is required',
  });
export type CreateInput = z.infer<typeof createSchema>;

export const snoozeSchema = z.object({
  id: z.number().int().positive(),
  minutes: z.number().int().min(1).max(60 * 24 * 30),
});
export type SnoozeInput = z.infer<typeof snoozeSchema>;

export const idSchema = z.object({ id: z.number().int().positive() });

export interface ReminderRow {
  id: number;
  userId: number;
  text: string;
  fireAt: string;
  nextFireAt: string | null;
  recurrence: string | null;
  tags: string[];
  createdAt: string;
  deliveredAt: string | null;
  dismissedAt: string | null;
  snoozedUntil: string | null;
  source: string | null;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — pglite returns `{rows:[]}`; postgres.js returns plain array. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  /* v8 ignore next — pglite returns timestamps as strings, so the Date branch
     only fires under postgres.js in production. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — parseable timestamps in both drivers. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function normaliseTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((x): x is string => typeof x === 'string');
  if (typeof input === 'string') return parsePgArrayLiteral(input);
  return [];
}

function parsePgArrayLiteral(s: string): string[] {
  if (s.length < 2 || s[0] !== '{' || s[s.length - 1] !== '}') return [];
  const inner = s.slice(1, -1);
  if (inner === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      let buf = '';
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          buf += inner[i + 1];
          i += 2;
        } else {
          buf += inner[i];
          i++;
        }
      }
      out.push(buf);
      i++;
      if (inner[i] === ',') i++;
    } else {
      let buf = '';
      while (i < inner.length && inner[i] !== ',') {
        buf += inner[i];
        i++;
      }
      /* v8 ignore next 3 — defensive: nudge.reminders.tags is NOT NULL DEFAULT '{}'. */
      if (buf === 'NULL') {
        out.push('');
      } else {
        out.push(buf);
      }
      if (inner[i] === ',') i++;
    }
  }
  return out;
}

function rowFromDb(row: Record<string, unknown>): ReminderRow {
  return {
    id: Number(row.id),
    /* v8 ignore next — every caller aliases user_id AS "userId" so the snake_case
       fallback is defensive only. */
    userId: Number(row.userId ?? row.user_id),
    /* v8 ignore next — text is NOT NULL. */
    text: String(row.text ?? ''),
    fireAt: toIsoOrNull(row.fireAt as Date | string)!,
    nextFireAt: toIsoOrNull(row.nextFireAt as Date | string | null),
    recurrence: (row.recurrence as string | null) ?? null,
    tags: normaliseTags(row.tags),
    createdAt: toIsoOrNull(row.createdAt as Date | string)!,
    deliveredAt: toIsoOrNull(row.deliveredAt as Date | string | null),
    dismissedAt: toIsoOrNull(row.dismissedAt as Date | string | null),
    snoozedUntil: toIsoOrNull(row.snoozedUntil as Date | string | null),
    source: (row.source as string | null) ?? null,
  };
}

/**
 * Advance a recurring reminder's next-fire time.  Returns null for one-shot
 * reminders.  Inputs:
 *   - 'daily'   → +1 day
 *   - 'weekly'  → +7 days
 *   - 'monthly' → +1 calendar month (UTC)
 *   - 'every:Nx' where x in s|m|h|d
 */
export function computeNextFire(
  recurrence: string | null | undefined,
  from: Date,
): Date | null {
  if (!recurrence) return null;
  if (recurrence === 'daily') {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  if (recurrence === 'weekly') {
    return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  if (recurrence === 'monthly') {
    const d = new Date(from);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
  }
  const m = /^every:([0-9]+)(s|m|h|d)$/.exec(recurrence);
  /* v8 ignore next — regex-validated upstream; defensive. */
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60 * 1000 :
    unit === 'h' ? n * 60 * 60 * 1000 :
    n * 24 * 60 * 60 * 1000;
  if (ms <= 0) return null;
  return new Date(from.getTime() + ms);
}

// ---------- Create ----------

export interface CreateResult {
  id: number;
  fireAt: string;
  nextFireAt: string | null;
}

export async function createReminderImpl(
  db: DB,
  userId: number,
  input: CreateInput,
  now: Date = new Date(),
): Promise<CreateResult> {
  const fireAt = input.fireAt
    ? new Date(input.fireAt)
    /* v8 ignore next — schema guarantees relativeSeconds is defined when fireAt isn't. */
    : new Date(now.getTime() + (input.relativeSeconds ?? 0) * 1000);
  const recurrence = input.recurrence ?? null;
  const nextFireAt = recurrence ? computeNextFire(recurrence, fireAt) : null;
  const [created] = await db
    .insert(reminders)
    .values({
      userId,
      text: input.text,
      fireAt,
      nextFireAt,
      recurrence,
      tags: input.tags ?? [],
      source: input.source ?? null,
      createdAt: now,
    })
    .returning({
      id: reminders.id,
      fireAt: reminders.fireAt,
      nextFireAt: reminders.nextFireAt,
    });
  /* v8 ignore next — RETURNING always yields one row on successful INSERT. */
  if (!created) throw new Error('createReminderImpl: insert returned no row');
  return {
    id: created.id,
    fireAt: created.fireAt.toISOString(),
    nextFireAt: created.nextFireAt ? created.nextFireAt.toISOString() : null,
  };
}

// ---------- Listing ----------

export async function listUpcomingImpl(
  db: DB,
  userId: number,
  withinSeconds = 60 * 60 * 24,
  now: Date = new Date(),
): Promise<ReminderRow[]> {
  const upper = new Date(now.getTime() + withinSeconds * 1000);
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        text,
        fire_at AS "fireAt",
        next_fire_at AS "nextFireAt",
        recurrence,
        tags,
        created_at AS "createdAt",
        delivered_at AS "deliveredAt",
        dismissed_at AS "dismissedAt",
        snoozed_until AS "snoozedUntil",
        source
      FROM nudge.reminders
      WHERE user_id = ${userId}
        AND dismissed_at IS NULL
        AND fire_at <= ${upper.toISOString()}::timestamptz
      ORDER BY fire_at ASC
      LIMIT 200
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowFromDb(r as Record<string, unknown>));
}

export async function listAllImpl(
  db: DB,
  userId: number,
  opts: { includeDismissed?: boolean; limit?: number } = {},
): Promise<ReminderRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
  const includeDismissed = opts.includeDismissed === true;
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        text,
        fire_at AS "fireAt",
        next_fire_at AS "nextFireAt",
        recurrence,
        tags,
        created_at AS "createdAt",
        delivered_at AS "deliveredAt",
        dismissed_at AS "dismissedAt",
        snoozed_until AS "snoozedUntil",
        source
      FROM nudge.reminders
      WHERE user_id = ${userId}
        AND (${includeDismissed} OR dismissed_at IS NULL)
      ORDER BY fire_at DESC
      LIMIT ${limit}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowFromDb(r as Record<string, unknown>));
}

export async function getReminderImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<ReminderRow | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        text,
        fire_at AS "fireAt",
        next_fire_at AS "nextFireAt",
        recurrence,
        tags,
        created_at AS "createdAt",
        delivered_at AS "deliveredAt",
        dismissed_at AS "dismissedAt",
        snoozed_until AS "snoozedUntil",
        source
      FROM nudge.reminders
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return rowFromDb(first as Record<string, unknown>);
}

// ---------- Mutations ----------

export async function dismissReminderImpl(
  db: DB,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      UPDATE nudge.reminders
      SET dismissed_at = ${now.toISOString()}::timestamptz,
          next_fire_at = NULL
      WHERE id = ${id} AND user_id = ${userId} AND dismissed_at IS NULL
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export async function snoozeReminderImpl(
  db: DB,
  userId: number,
  id: number,
  minutes: number,
  now: Date = new Date(),
): Promise<ReminderRow | null> {
  const until = new Date(now.getTime() + minutes * 60 * 1000);
  const result = (await db.execute(
    sql`
      UPDATE nudge.reminders
      SET snoozed_until = ${until.toISOString()}::timestamptz,
          fire_at = ${until.toISOString()}::timestamptz
      WHERE id = ${id} AND user_id = ${userId} AND dismissed_at IS NULL
      RETURNING
        id,
        user_id AS "userId",
        text,
        fire_at AS "fireAt",
        next_fire_at AS "nextFireAt",
        recurrence,
        tags,
        created_at AS "createdAt",
        delivered_at AS "deliveredAt",
        dismissed_at AS "dismissedAt",
        snoozed_until AS "snoozedUntil",
        source
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return rowFromDb(first as Record<string, unknown>);
}

export async function deleteReminderImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM nudge.reminders
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// ---------- Cron-side: due reminders ----------

export interface DueRow {
  id: number;
  userId: number;
  text: string;
  fireAt: string;
  recurrence: string | null;
}

export async function listDueImpl(
  db: DB,
  now: Date = new Date(),
  limit = 500,
): Promise<DueRow[]> {
  const cappedLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        text,
        fire_at AS "fireAt",
        recurrence
      FROM nudge.reminders
      WHERE dismissed_at IS NULL
        AND delivered_at IS NULL
        AND fire_at <= ${now.toISOString()}::timestamptz
      ORDER BY fire_at ASC
      LIMIT ${cappedLimit}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: Number(row.id),
      userId: Number(row.userId),
      /* v8 ignore next — text is NOT NULL. */
      text: String(row.text ?? ''),
      fireAt: toIsoOrNull(row.fireAt as Date | string)!,
      recurrence: (row.recurrence as string | null) ?? null,
    };
  });
}

/**
 * Mark a reminder as delivered.  For recurring reminders, advance fire_at to
 * the next slot and clear delivered_at so the next tick can re-fire.
 */
export async function markDeliveredImpl(
  db: DB,
  id: number,
  now: Date = new Date(),
): Promise<void> {
  const current = (await db.execute(
    sql`
      SELECT id, recurrence, fire_at AS "fireAt"
      FROM nudge.reminders
      WHERE id = ${id}
      LIMIT 1
    `,
  )) as unknown;
  const [row] = rowsOf(current);
  /* v8 ignore next — caller passes ids from listDueImpl, so the row exists. */
  if (!row) return;
  const r = row as { recurrence: string | null; fireAt: Date | string };
  const next = r.recurrence ? computeNextFire(r.recurrence, new Date(r.fireAt)) : null;
  if (next) {
    const afterNext = computeNextFire(r.recurrence, next);
    /* v8 ignore next — afterNext is non-null whenever next is non-null with the
       same recurrence: same shape, same valid pattern. */
    const afterNextIso = afterNext ? afterNext.toISOString() : null;
    await db.execute(sql`
      UPDATE nudge.reminders
      SET fire_at = ${next.toISOString()}::timestamptz,
          next_fire_at = ${afterNextIso}::timestamptz,
          delivered_at = NULL
      WHERE id = ${id}
    `);
  } else {
    await db.execute(sql`
      UPDATE nudge.reminders
      SET delivered_at = ${now.toISOString()}::timestamptz
      WHERE id = ${id}
    `);
  }
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  upcoming: ReminderRow[];
  count: number;
}

export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  now: Date = new Date(),
): Promise<HomePayload | null> {
  if (!sub) return null;
  const meResult = (await db.execute(
    sql`
      SELECT id, login FROM pm.users
      WHERE better_auth_user_id = ${sub} AND status = 'active'
      LIMIT 1
    `,
  )) as unknown;
  const [meRow] = rowsOf(meResult);
  if (!meRow) return null;
  const me = meRow as { id: number; login: string };
  const upcoming = await listUpcomingImpl(db, me.id, 60 * 60 * 24, now);
  return {
    me: { id: Number(me.id), login: me.login },
    upcoming,
    count: upcoming.length,
  };
}

// ---------- HMAC client lookup ----------

export interface ApiClientRow {
  id: number;
  clientId: string;
  name: string;
  hmacSecret: string;
  userId: number;
}

export async function findApiClientImpl(
  db: DB,
  clientId: string,
): Promise<ApiClientRow | null> {
  const rows = (await db.execute(
    sql`
      SELECT id, client_id AS "clientId", name, hmac_secret AS "hmacSecret", user_id AS "userId"
      FROM nudge.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  const row = first as ApiClientRow;
  return {
    id: Number(row.id),
    clientId: row.clientId,
    name: row.name,
    hmacSecret: row.hmacSecret,
    userId: Number(row.userId),
  };
}

// ---------- Admin: api-client CRUD ----------

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const createApiClientSchema = z.object({
  clientId: z.string().regex(CLIENT_ID_RE, 'lowercase, digits, _-, 2-64 chars'),
  name: z.string().min(1).max(120),
});
export type CreateApiClientInput = z.infer<typeof createApiClientSchema>;

export interface CreateApiClientResult {
  clientId: string;
  name: string;
  hmacSecret: string;
  createdAt: string;
}

export async function createApiClientImpl(
  db: DB,
  userId: number,
  input: CreateApiClientInput,
  now: Date = new Date(),
): Promise<CreateApiClientResult> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const hmacSecret = btoa(bin);

  await db.execute(sql`
    INSERT INTO nudge.api_clients (client_id, name, hmac_secret, user_id, created_at)
    VALUES (${input.clientId}, ${input.name}, ${hmacSecret}, ${userId}, ${now.toISOString()}::timestamptz)
  `);
  return {
    clientId: input.clientId,
    name: input.name,
    hmacSecret,
    createdAt: now.toISOString(),
  };
}

export interface ApiClientListItem {
  clientId: string;
  name: string;
  createdAt: string;
}

export async function listApiClientsImpl(
  db: DB,
  userId: number,
): Promise<ApiClientListItem[]> {
  const result = (await db.execute(
    sql`
      SELECT client_id AS "clientId", name, created_at AS "createdAt"
      FROM nudge.api_clients
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as { clientId: string; name: string; createdAt: Date | string };
    return {
      clientId: row.clientId,
      name: row.name,
      createdAt: toIsoOrNull(row.createdAt)!,
    };
  });
}

export async function deleteApiClientImpl(
  db: DB,
  userId: number,
  clientId: string,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM nudge.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export { reminders };

export const _testing = { parsePgArrayLiteral, normaliseTags, rowFromDb };
