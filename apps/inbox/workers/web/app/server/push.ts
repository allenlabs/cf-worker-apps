// Web Push impls.  Plain functions that take an injected DB + Env so they
// run against PGlite in tests without dragging in the TanStack Start
// runtime — same convention as `server/inbox.ts`.
//
// Outbound delivery uses `@betternotify/webpush`'s `vapidTransport` directly
// instead of the full `@betternotify/core` `createNotify(...).<route>.send`
// builder API.  Rationale:
//   - The builder API is designed for catalogs of many message types with
//     schema-validated inputs (`rpc.catalog({ newMessage: rpc.webpush()… })`);
//     we send exactly one shape of payload (`{title, body, url, tag}`) so
//     the extra ceremony buys nothing.
//   - `vapidTransport(opts).send(rendered, ctx)` is the lowest-level
//     primitive that returns per-subscription `{endpoint, ok, gone,
//     statusCode}` results we need to drive cleanup.  The builder API
//     ultimately calls the same code path; we just skip the schema /
//     catalog layer.
//   - Pure Web-Crypto under the hood — no `node:crypto` import, works
//     natively on workerd.
//
// `createTransport` is exposed so tests can stub the send path; production
// callers should pass the real `vapidTransport` from `~/lib/push-transport`.

import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';
import { vapidTransport } from '@betternotify/webpush/transports';

/** Subset of the worker Env push impls actually read.  Narrower than the
 *  full `~/lib/env` Env so the API worker (with its own Env shape) can
 *  pass its env without a `as unknown as` cast. */
export interface PushEnv {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  PUBLIC_BASE_URL?: string;
}

// ---------- Types ----------

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  failedCount: number;
}

export interface PushPreferencesRow {
  userId: number;
  onCapture: boolean;
  quietStart: number | null;
  quietEnd: number | null;
}

/** Defaults applied when a user has never written a preference row. */
export const DEFAULT_PREFERENCES: Omit<PushPreferencesRow, 'userId'> = {
  onCapture: true,
  quietStart: null,
  quietEnd: null,
};

export interface PushSendResult {
  endpoint: string;
  ok: boolean;
  statusCode?: number;
  gone?: boolean;
}

/** Per-subscription transport result shape used to drive cleanup. */
export interface PushTransport {
  send(
    rendered: {
      title: string;
      body: string;
      tag?: string;
      data?: Record<string, unknown>;
      to: WebPushSubscription;
    },
    ctx: { route: string; messageId: string },
  ): Promise<
    | { ok: true; data: { results: ReadonlyArray<PushSendResult> } }
    | { ok: false; error: unknown }
  >;
}

/** Snapshot of the captured item the notification copies from. */
export interface CapturedItemForNotify {
  id: number;
  text: string;
}

// ---------- Helpers ----------

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch
     in tests; the plain-array branch is the production path through
     postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — defensive only; never hit with a well-formed driver. */
  return Array.isArray(rows) ? rows : [];
}

/**
 * `quiet_start`/`quiet_end` are minutes-from-local-midnight (0..1439).
 * Windows that span midnight (e.g. 22:00 → 06:00) wrap naturally.  If
 * either bound is null we treat quiet-hours as disabled.
 */
export function inQuietHours(
  prefs: PushPreferencesRow,
  now: Date = new Date(),
): boolean {
  const start = prefs.quietStart;
  const end = prefs.quietEnd;
  if (start == null || end == null) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  // Wraps past midnight: inside if AFTER start OR BEFORE end.
  return minutes >= start || minutes < end;
}

// ---------- Subscription registration ----------

export async function registerSubscriptionImpl(
  db: DB,
  userId: number,
  sub: WebPushSubscription,
  userAgent: string | null,
): Promise<{ id: number }> {
  const result = (await db.execute(
    sql`
      INSERT INTO inbox.push_subscriptions
        (user_id, endpoint, p256dh, auth, user_agent, failed_count)
      VALUES
        (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${userAgent}, 0)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id      = EXCLUDED.user_id,
        p256dh       = EXCLUDED.p256dh,
        auth         = EXCLUDED.auth,
        user_agent   = EXCLUDED.user_agent,
        failed_count = 0,
        last_used_at = NOW()
      RETURNING id
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — RETURNING on a successful INSERT/UPDATE always yields
     one row; an empty result would mean a driver bug. */
  if (!first) throw new Error('registerSubscriptionImpl: insert returned no row');
  return first as { id: number };
}

export async function removeSubscriptionImpl(
  db: DB,
  userId: number,
  endpoint: string,
): Promise<{ removed: number }> {
  const result = (await db.execute(
    sql`
      DELETE FROM inbox.push_subscriptions
      WHERE endpoint = ${endpoint} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return { removed: rowsOf(result).length };
}

// ---------- Preferences ----------

export async function getPreferencesImpl(
  db: DB,
  userId: number,
): Promise<PushPreferencesRow> {
  const result = (await db.execute(
    sql`
      SELECT user_id     AS "userId",
             on_capture  AS "onCapture",
             quiet_start AS "quietStart",
             quiet_end   AS "quietEnd"
      FROM inbox.push_preferences
      WHERE user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return { userId, ...DEFAULT_PREFERENCES };
  return first as PushPreferencesRow;
}

export interface SetPreferencesInput {
  onCapture?: boolean;
  quietStart?: number | null;
  quietEnd?: number | null;
}

export async function setPreferencesImpl(
  db: DB,
  userId: number,
  input: SetPreferencesInput,
): Promise<PushPreferencesRow> {
  // Read-modify-write so partial updates preserve existing fields.
  const current = await getPreferencesImpl(db, userId);
  const next: PushPreferencesRow = {
    userId,
    onCapture: input.onCapture ?? current.onCapture,
    quietStart:
      input.quietStart === undefined ? current.quietStart : input.quietStart,
    quietEnd: input.quietEnd === undefined ? current.quietEnd : input.quietEnd,
  };
  await db.execute(
    sql`
      INSERT INTO inbox.push_preferences (user_id, on_capture, quiet_start, quiet_end, updated_at)
      VALUES (${next.userId}, ${next.onCapture}, ${next.quietStart}, ${next.quietEnd}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        on_capture  = EXCLUDED.on_capture,
        quiet_start = EXCLUDED.quiet_start,
        quiet_end   = EXCLUDED.quiet_end,
        updated_at  = NOW()
    `,
  );
  return next;
}

// ---------- Send-on-capture ----------

const MAX_FAILED_BEFORE_DELETE = 5;

/**
 * Look up the user's subscriptions + preferences and fan out a push
 * notification for the just-captured item.  Honors the `on_capture`
 * opt-out and the quiet-hours window.  Failed deliveries bump
 * `failed_count`; subscriptions that come back as 404/410 or that have
 * crossed the failure threshold are deleted.
 *
 * Returns a small audit shape so callers (tests, future telemetry) can
 * see what happened without re-querying.
 */
export interface SendCaptureResult {
  skipped: 'opt-out' | 'quiet-hours' | 'no-subs' | null;
  sent: number;
  failed: number;
  deleted: number;
}

export interface SendCaptureDeps {
  transport: PushTransport;
  now?: Date;
}

export async function sendCaptureNotificationImpl(
  env: PushEnv,
  db: DB,
  userId: number,
  item: CapturedItemForNotify,
  deps: SendCaptureDeps,
): Promise<SendCaptureResult> {
  const prefs = await getPreferencesImpl(db, userId);
  if (!prefs.onCapture) {
    return { skipped: 'opt-out', sent: 0, failed: 0, deleted: 0 };
  }
  if (inQuietHours(prefs, deps.now)) {
    return { skipped: 'quiet-hours', sent: 0, failed: 0, deleted: 0 };
  }

  const subResult = (await db.execute(
    sql`
      SELECT id, endpoint, p256dh, auth, failed_count AS "failedCount"
      FROM inbox.push_subscriptions
      WHERE user_id = ${userId}
    `,
  )) as unknown;
  const subs = rowsOf(subResult) as StoredSubscription[];
  if (subs.length === 0) {
    return { skipped: 'no-subs', sent: 0, failed: 0, deleted: 0 };
  }

  // Build the notification payload once.  `tag` collapses duplicate
  // notifications on the device so a flurry of captures shows as one bell.
  const body = item.text.length > 100 ? `${item.text.slice(0, 97)}...` : item.text;
  const baseRendered = {
    title: 'New in inbox',
    body,
    tag: 'inbox-capture',
    data: { url: `${env.PUBLIC_BASE_URL ?? 'https://inbox.allenlabs.org'}/` },
  } as const;
  // `vapidTransport.send` accepts either a single subscription or an
  // array via `rendered.to`.  We dispatch per-subscription so a single
  // failure doesn't bring down the whole fan-out and we can record
  // failures granularly.
  let sent = 0;
  let failed = 0;
  const goneEndpoints: string[] = [];
  const failedEndpoints: number[] = [];
  for (const sub of subs) {
    const ctx = { route: 'inbox.capture', messageId: `${item.id}:${sub.id}` };
    try {
      const out = await deps.transport.send(
        {
          ...baseRendered,
          to: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        },
        ctx,
      );
      const result = out.ok ? out.data.results[0] : null;
      if (out.ok && result?.ok) {
        sent++;
        await db.execute(
          sql`
            UPDATE inbox.push_subscriptions
            SET last_used_at = NOW(), failed_count = 0
            WHERE id = ${sub.id}
          `,
        );
      } else {
        failed++;
        const gone = result?.gone === true;
        if (gone) {
          goneEndpoints.push(sub.endpoint);
        } else if (sub.failedCount + 1 >= MAX_FAILED_BEFORE_DELETE) {
          failedEndpoints.push(sub.id);
        } else {
          await db.execute(
            sql`
              UPDATE inbox.push_subscriptions
              SET failed_count = failed_count + 1
              WHERE id = ${sub.id}
            `,
          );
        }
      }
    } catch (_e) {
      // Treat thrown errors the same as a non-ok response — count, bump
      // failure, but never let one bad endpoint crash the whole fan-out.
      failed++;
      if (sub.failedCount + 1 >= MAX_FAILED_BEFORE_DELETE) {
        failedEndpoints.push(sub.id);
      } else {
        await db.execute(
          sql`
            UPDATE inbox.push_subscriptions
            SET failed_count = failed_count + 1
            WHERE id = ${sub.id}
          `,
        );
      }
    }
  }

  let deleted = 0;
  for (const ep of goneEndpoints) {
    // One DELETE per gone-endpoint instead of `WHERE endpoint = ANY($1)`
    // — keeps the parameter binding flat (PGlite's binder chokes on
    // numeric arrays via ANY).  Cleanup is rare, so the per-row cost is
    // negligible.
    const r = (await db.execute(
      sql`
        DELETE FROM inbox.push_subscriptions
        WHERE endpoint = ${ep}
        RETURNING id
      `,
    )) as unknown;
    deleted += rowsOf(r).length;
  }
  for (const id of failedEndpoints) {
    const r = (await db.execute(
      sql`
        DELETE FROM inbox.push_subscriptions
        WHERE id = ${id}
        RETURNING id
      `,
    )) as unknown;
    deleted += rowsOf(r).length;
  }

  return { skipped: null, sent, failed, deleted };
}

// ---------- Production transport wiring ----------
//
// The runtime helper that bridges Env → vapidTransport.  Wrapped in
// `/* v8 ignore */` because exercising the real transport requires the
// network; covered by the deploy smoke test instead.
/* v8 ignore start */
export function makeVapidTransport(env: PushEnv): PushTransport {
  return vapidTransport({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  }) as unknown as PushTransport;
}
/* v8 ignore stop */
