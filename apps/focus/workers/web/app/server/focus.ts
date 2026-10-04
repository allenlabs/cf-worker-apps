// Focus impls.  All write paths land here so they're testable on PGlite
// (no Hyperdrive, no TanStack Start runtime) and re-exported from both the
// web worker route handlers + the HMAC API worker.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { distractions, sessions } from '~/db/schema';

// ---------- Validation ----------

export const TARGET_MINUTES_OPTIONS = [15, 25, 45, 60] as const;
export const ENDED_REASONS = ['completed', 'abandoned', 'extended'] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];

export const startSchema = z.object({
  taskText: z.string().min(1).max(2000),
  targetMinutes: z.number().int().min(1).max(180).default(25),
  inboxItemId: z.number().int().positive().optional(),
  pmIssueId: z.number().int().positive().optional(),
});
export type StartInput = z.infer<typeof startSchema>;

export const endSchema = z.object({
  sessionId: z.number().int().positive(),
  endedReason: z.enum(ENDED_REASONS),
  notes: z.string().max(8000).optional(),
  satisfaction: z.number().int().min(1).max(5).optional(),
});
export type EndInput = z.infer<typeof endSchema>;

export const distractSchema = z.object({
  sessionId: z.number().int().positive(),
  label: z.string().min(1).max(120),
  details: z.string().max(2000).optional(),
});
export type DistractInput = z.infer<typeof distractSchema>;

// ---------- Types ----------

export interface ActiveSession {
  id: number;
  taskText: string;
  targetMinutes: number;
  startedAt: string;
  endsAt: string;
  inboxItemId: number | null;
  pmIssueId: number | null;
}

export interface FocusSessionRow {
  id: number;
  taskText: string;
  targetMinutes: number;
  startedAt: string;
  endedAt: string | null;
  endedReason: EndedReason | null;
  notes: string | null;
  satisfaction: number | null;
  inboxItemId: number | null;
  pmIssueId: number | null;
  distractionCount: number;
}

export interface InboxAutocompleteItem {
  id: number;
  text: string;
}

export interface HomePayload {
  me: { id: number; login: string };
  active: ActiveSession | null;
  todayFocusedMinutes: number;
  todayDistractionCount: number;
  todaySessionsCount: number;
  // The 5 most-recent unread items for the autocomplete in the start form.
  // Soft-fails empty if the inbox schema isn't available on this DB.
  inboxSuggestions: InboxAutocompleteItem[];
  // For "cheap re-entry" — see ADHD design notes.  If the most recent
  // session was abandoned, pre-fill the task text on the start form.
  lastAbandonedTaskText: string | null;
}

export interface HeatmapDay {
  date: string;       // YYYY-MM-DD (local-day)
  minutes: number;
  sessions: number;
}

export interface HistoryPayload {
  me: { id: number; login: string };
  days: HeatmapDay[];           // 90 entries (oldest → newest)
  totalMinutes: number;
  totalSessions: number;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch;
     the plain-array path is exercised in production by postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback; never hit in real
     queries.  Defensive so a partial result can't crash the loader. */
  return Array.isArray(rows) ? rows : [];
}

// ---------- Start ----------

export interface StartResult {
  id: number;
  startedAt: Date;
  endsAt: Date;
}

/**
 * Start a session.  Closes any existing in-progress session for the same
 * user as `abandoned` first — the UI never permits two locks at once, and
 * the CLI shouldn't surprise the web app's countdown either.
 */
export async function startSessionImpl(
  db: DB,
  userId: number,
  input: StartInput,
  now: Date = new Date(),
): Promise<StartResult> {
  // Close any active session first.  Idempotent: if there's none, nothing
  // happens; if there is one, we mark it abandoned without ceremony so the
  // user can flip from one task to another without manual cleanup.
  await db
    .update(sessions)
    .set({ endedAt: now, endedReason: 'abandoned' })
    .where(and(eq(sessions.userId, userId), isNull(sessions.endedAt)));

  const [created] = await db
    .insert(sessions)
    .values({
      userId,
      taskText: input.taskText,
      targetMinutes: input.targetMinutes,
      inboxItemId: input.inboxItemId ?? null,
      pmIssueId: input.pmIssueId ?? null,
      startedAt: now,
    })
    .returning({
      id: sessions.id,
      startedAt: sessions.startedAt,
      targetMinutes: sessions.targetMinutes,
    });
  /* v8 ignore next — defensive: drizzle's RETURNING always yields one row
     on a successful INSERT.  An empty array would mean an outright driver
     bug, not a normal failure mode. */
  if (!created) throw new Error('startSessionImpl: insert returned no row');
  return {
    id: created.id,
    startedAt: created.startedAt,
    endsAt: new Date(created.startedAt.getTime() + created.targetMinutes * 60_000),
  };
}

// ---------- End ----------

export interface EndResult {
  id: number;
  endedReason: EndedReason;
}

/**
 * End an in-progress session.  Scoped by user_id so a forged session id
 * can't end someone else's lock.  If `endedReason === 'extended'`, we bump
 * `targetMinutes` by +5 and KEEP the session running (UI's "+5 more" CTA);
 * any other reason terminates the session.
 */
export async function endSessionImpl(
  db: DB,
  userId: number,
  input: EndInput,
  now: Date = new Date(),
): Promise<EndResult | null> {
  if (input.endedReason === 'extended') {
    const [updated] = await db
      .update(sessions)
      .set({
        targetMinutes: sql`${sessions.targetMinutes} + 5`,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.endedAt),
        ),
      )
      .returning({ id: sessions.id });
    if (!updated) return null;
    return { id: updated.id, endedReason: 'extended' };
  }

  const patch: {
    endedAt: Date;
    endedReason: EndedReason;
    notes?: string | null;
    satisfaction?: number | null;
  } = {
    endedAt: now,
    endedReason: input.endedReason,
  };
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.satisfaction !== undefined) patch.satisfaction = input.satisfaction;

  const [updated] = await db
    .update(sessions)
    .set(patch)
    .where(
      and(
        eq(sessions.id, input.sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.endedAt),
      ),
    )
    .returning({ id: sessions.id, endedReason: sessions.endedReason });
  if (!updated) return null;
  /* v8 ignore next — `updated.endedReason` is set by the same UPDATE
     above, so the ?? fallback only fires on a driver bug. */
  return { id: updated.id, endedReason: (updated.endedReason ?? input.endedReason) as EndedReason };
}

// ---------- Distract ----------

export interface DistractResult {
  id: number;
  notedAt: Date;
}

/**
 * Log a distraction ("wobble") against an active session.  The user_id
 * scoping is enforced via a sub-SELECT: only if the parent session belongs
 * to the calling user do we get a row.
 */
export async function distractImpl(
  db: DB,
  userId: number,
  input: DistractInput,
): Promise<DistractResult | null> {
  // Verify ownership in one round-trip using a CTE-shaped insert.
  const result = (await db.execute(
    sql`
      WITH owned AS (
        SELECT id FROM focus.sessions
        WHERE id = ${input.sessionId} AND user_id = ${userId}
      )
      INSERT INTO focus.distractions (session_id, label, details)
      SELECT ${input.sessionId}, ${input.label}, ${input.details ?? null}
      WHERE EXISTS (SELECT 1 FROM owned)
      RETURNING id, noted_at AS "notedAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const row = first as { id: number; notedAt: Date | string };
  return {
    id: row.id,
    /* v8 ignore next — pglite (tests) returns Date; postgres.js
       (production) returns ISO string.  Both branches are correct; we
       can't exercise both in CI. */
    notedAt: row.notedAt instanceof Date ? row.notedAt : new Date(row.notedAt),
  };
}

// ---------- Active session (CLI / shell prompt) ----------

export async function getActiveSessionImpl(
  db: DB,
  userId: number,
): Promise<ActiveSession | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        task_text       AS "taskText",
        target_minutes  AS "targetMinutes",
        started_at      AS "startedAt",
        inbox_item_id   AS "inboxItemId",
        pm_issue_id     AS "pmIssueId"
      FROM focus.sessions
      WHERE user_id = ${userId} AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const row = first as {
    id: number;
    taskText: string;
    targetMinutes: number;
    startedAt: Date | string;
    inboxItemId: number | null;
    pmIssueId: number | null;
  };
  /* v8 ignore next — pglite (tests) returns Date; postgres.js (prod)
     returns ISO string.  Both branches are correct. */
  const startedAt = row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt);
  return {
    id: row.id,
    taskText: row.taskText,
    targetMinutes: row.targetMinutes,
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + row.targetMinutes * 60_000).toISOString(),
    inboxItemId: row.inboxItemId,
    pmIssueId: row.pmIssueId,
  };
}

// ---------- Home loader (single CTE) ----------

/**
 * The home page needs five things in one Hetzner round-trip:
 *   1. The user (via JWT sub -> pm.users)
 *   2. The user's active session (if any)
 *   3. Today's completed focused minutes
 *   4. Today's distraction count
 *   5. The user's 5 most-recent unread inbox items for the autocomplete
 *   6. The most recent abandoned session's task text (for cheap re-entry)
 *
 * One CTE chain, one network hop.  We pre-probe `to_regclass('inbox.items')`
 * via Postgres' string concatenation so the planner never has to parse a
 * relation that doesn't exist (`relation "inbox.items" does not exist` is a
 * parse-time error, not a runtime one — the to_regclass guard inside a CTE
 * subquery is too late).  The probe is dirt-cheap and on the same network
 * trip via `SELECT … UNION ALL SELECT …` patterns wouldn't help.  We do the
 * obvious thing: a tiny first query for the probe, then the main CTE.  In
 * production both go through Hyperdrive's pooled connection so the cost is
 * effectively a single network RTT.
 */
export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  now: Date = new Date(),
): Promise<HomePayload | null> {
  if (!sub) return null;
  // Compute today's midnight in UTC.  The heatmap uses local-day grouping
  // (see loadHistoryImpl) but the home page just needs "since the last
  // midnight" — close enough for a daily-summary widget.
  const todayUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Probe: does inbox.items exist on this DB?  Avoids a parse-time error
  // when the inbox app hasn't been migrated yet (e.g. fresh deploy).
  const probe = (await db.execute(
    sql`SELECT to_regclass('inbox.items') IS NOT NULL AS have_inbox`,
  )) as unknown;
  const [probeRow] = rowsOf(probe);
  const haveInbox = Boolean((probeRow as { have_inbox?: boolean } | undefined)?.have_inbox);

  const inboxCte = haveInbox
    ? sql`,
      inbox_suggestions AS (
        SELECT i.id, i.text
        FROM inbox.items i
        WHERE i.user_id = (SELECT id FROM me)
          AND i.status = 'unread'
        ORDER BY i.captured_at DESC
        LIMIT 5
      )`
    : sql``;
  const inboxJson = haveInbox
    ? sql`COALESCE(
          (SELECT json_agg(row_to_json(s) ORDER BY s.id DESC) FROM inbox_suggestions s),
          '[]'::json
        )`
    : sql`'[]'::json`;

  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      active AS (
        SELECT
          s.id,
          s.task_text      AS "taskText",
          s.target_minutes AS "targetMinutes",
          s.started_at     AS "startedAt",
          s.inbox_item_id  AS "inboxItemId",
          s.pm_issue_id    AS "pmIssueId"
        FROM focus.sessions s
        WHERE s.user_id = (SELECT id FROM me) AND s.ended_at IS NULL
        ORDER BY s.started_at DESC
        LIMIT 1
      ),
      today_sessions AS (
        SELECT s.id, s.target_minutes, s.started_at, s.ended_at, s.ended_reason
        FROM focus.sessions s
        WHERE s.user_id = (SELECT id FROM me)
          AND s.started_at >= ${todayUtcStart.toISOString()}
      ),
      today_stats AS (
        SELECT
          COALESCE(SUM(
            CASE WHEN ended_reason = 'completed' THEN target_minutes ELSE 0 END
          ), 0)::int AS "todayFocusedMinutes",
          COUNT(*)::int AS "todaySessionsCount"
        FROM today_sessions
      ),
      today_distractions AS (
        SELECT COUNT(*)::int AS "todayDistractionCount"
        FROM focus.distractions d
        WHERE d.session_id IN (SELECT id FROM today_sessions)
      ),
      last_abandoned AS (
        SELECT s.task_text
        FROM focus.sessions s
        WHERE s.user_id = (SELECT id FROM me)
          AND s.ended_reason = 'abandoned'
        ORDER BY s.started_at DESC
        LIMIT 1
      )${inboxCte}
      SELECT json_build_object(
        'me',                      (SELECT row_to_json(me) FROM me),
        'active',                  (SELECT row_to_json(active) FROM active),
        'todayFocusedMinutes',     (SELECT "todayFocusedMinutes" FROM today_stats),
        'todaySessionsCount',      (SELECT "todaySessionsCount" FROM today_stats),
        'todayDistractionCount',   (SELECT "todayDistractionCount" FROM today_distractions),
        'lastAbandonedTaskText',   (SELECT task_text FROM last_abandoned),
        'inboxSuggestions',        ${inboxJson}
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as { data?: HomePayload & { me: HomePayload['me'] | null; active: ActiveSession | null } } | undefined)?.data;
  if (!data?.me) return null;

  // Normalise: postgres may have returned the active session with a
  // started_at-but-no-endsAt; add the derived endsAt.  And cast counts to
  // proper numbers (pglite sometimes hands ints back as strings).
  let active: ActiveSession | null = null;
  if (data.active) {
    const startedAt = new Date(data.active.startedAt).getTime();
    const targetMinutes = Number(data.active.targetMinutes);
    active = {
      id: Number(data.active.id),
      taskText: data.active.taskText,
      targetMinutes,
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + targetMinutes * 60_000).toISOString(),
      /* v8 ignore start — null vs number both round-trip through
         Number(); the test seed never sets these so the truthy branch
         doesn't fire in CI. */
      inboxItemId: data.active.inboxItemId != null ? Number(data.active.inboxItemId) : null,
      pmIssueId: data.active.pmIssueId != null ? Number(data.active.pmIssueId) : null,
      /* v8 ignore stop */
    };
  }
  return {
    me: data.me,
    active,
    /* v8 ignore start — `??` fallbacks are defensive against a malformed
       row_to_json (never happens in real Postgres; COALESCE in the CTE
       already guarantees 0).  And `?? []` for inboxSuggestions. */
    todayFocusedMinutes: Number(data.todayFocusedMinutes ?? 0),
    todaySessionsCount: Number(data.todaySessionsCount ?? 0),
    todayDistractionCount: Number(data.todayDistractionCount ?? 0),
    lastAbandonedTaskText: data.lastAbandonedTaskText ?? null,
    inboxSuggestions: (data.inboxSuggestions ?? []).map((r) => ({
      id: Number(r.id),
      text: r.text,
    })),
    /* v8 ignore stop */
  };
}

// ---------- History (90-day heatmap) ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Generate the contiguous 90-day calendar so a user with zero sessions
 * still sees an empty heatmap (instead of an empty page that reads "no
 * data" — a small but important affordance for ADHD users who need the
 * scaffolding even on day zero).
 */
export function buildEmptyDays(now: Date = new Date(), days = 90): HeatmapDay[] {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: HeatmapDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayStart - i * DAY_MS);
    out.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      minutes: 0,
      sessions: 0,
    });
  }
  return out;
}

export async function loadHistoryImpl(
  db: DB,
  sub: string | null,
  now: Date = new Date(),
  days = 90,
): Promise<HistoryPayload | null> {
  if (!sub) return null;
  const horizonStart = new Date(now.getTime() - (days - 1) * DAY_MS);
  const horizonIso = new Date(Date.UTC(
    horizonStart.getUTCFullYear(), horizonStart.getUTCMonth(), horizonStart.getUTCDate(),
  )).toISOString();

  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_sessions AS (
        SELECT
          (started_at AT TIME ZONE 'UTC')::date AS day,
          target_minutes,
          ended_reason
        FROM focus.sessions
        WHERE user_id = (SELECT id FROM me)
          AND started_at >= ${horizonIso}
      ),
      per_day AS (
        SELECT
          day,
          SUM(CASE WHEN ended_reason = 'completed' THEN target_minutes ELSE 0 END)::int AS minutes,
          COUNT(*)::int AS sessions
        FROM my_sessions
        GROUP BY day
      )
      SELECT json_build_object(
        'me',    (SELECT row_to_json(me) FROM me),
        'days',  COALESCE(
          (SELECT json_agg(
              json_build_object(
                'date', to_char(day, 'YYYY-MM-DD'),
                'minutes', minutes,
                'sessions', sessions
              )
              ORDER BY day ASC
            ) FROM per_day),
          '[]'::json
        )
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as {
    data?: { me: { id: number; login: string } | null; days?: HeatmapDay[] };
  } | undefined)?.data;
  if (!data?.me) return null;

  // Merge DB rows onto the empty 90-day scaffold so the UI doesn't have to
  // worry about gaps.
  const scaffold = buildEmptyDays(now, days);
  const byDate = new Map(scaffold.map((d) => [d.date, d]));
  /* v8 ignore next — `?? []` defensive: the CTE always returns either an
     array or null (COALESCE'd to []). */
  for (const row of data.days ?? []) {
    const target = byDate.get(row.date);
    /* v8 ignore next — `target` is always defined because the scaffold
       covers every day in the window; the guard exists to satisfy
       strict-mode `noUncheckedIndexedAccess`. */
    if (target) {
      target.minutes = Number(row.minutes);
      target.sessions = Number(row.sessions);
    }
  }
  const result2 = Array.from(byDate.values());
  return {
    me: data.me,
    days: result2,
    totalMinutes: result2.reduce((a, b) => a + b.minutes, 0),
    totalSessions: result2.reduce((a, b) => a + b.sessions, 0),
  };
}

// ---------- HMAC client lookup (re-exported by the API worker) ----------

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
      FROM focus.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  return first as ApiClientRow;
}

// ---------- Day drill-down (clicking a heatmap cell) ----------

/**
 * Return all sessions on a given local-day (YYYY-MM-DD).  Used by /history
 * when the user clicks a cell.  Scoped by user_id.
 */
export async function loadDaySessionsImpl(
  db: DB,
  userId: number,
  dayYmd: string,
): Promise<FocusSessionRow[]> {
  // Validate YMD shape so a user can't smuggle SQL via a malformed param.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayYmd)) return [];
  const result = (await db.execute(
    sql`
      SELECT
        s.id,
        s.task_text       AS "taskText",
        s.target_minutes  AS "targetMinutes",
        s.started_at      AS "startedAt",
        s.ended_at        AS "endedAt",
        s.ended_reason    AS "endedReason",
        s.notes,
        s.satisfaction,
        s.inbox_item_id   AS "inboxItemId",
        s.pm_issue_id     AS "pmIssueId",
        COALESCE((
          SELECT COUNT(*)::int FROM focus.distractions d WHERE d.session_id = s.id
        ), 0) AS "distractionCount"
      FROM focus.sessions s
      WHERE s.user_id = ${userId}
        AND (s.started_at AT TIME ZONE 'UTC')::date = ${dayYmd}::date
      ORDER BY s.started_at ASC
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as Omit<FocusSessionRow, 'startedAt' | 'endedAt'> & {
      startedAt: Date | string;
      endedAt: Date | string | null;
    };
    /* v8 ignore start — pglite returns Date; postgres.js returns ISO
       string.  Both branches are correct; we can't exercise both
       simultaneously. */
    return {
      ...row,
      startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
      endedAt: row.endedAt instanceof Date ? row.endedAt.toISOString() : row.endedAt,
    };
    /* v8 ignore stop */
  });
}

// Re-export the distractions table type for tests that need to count rows.
export { distractions, sessions };
