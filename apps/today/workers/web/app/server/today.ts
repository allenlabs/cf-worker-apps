// Today impls.  Single-CTE aggregator across pm.*, inbox.*, focus.* + the
// "one next action" picker.  Lives here so it's testable on PGlite (no
// Hyperdrive, no TanStack Start runtime).

import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';
import { sameLocalDay, truncate } from '~/lib/format';

// ---------- Types ----------

export interface MeRow {
  id: number;
  login: string;
  isAdmin: boolean;
}

export interface ActiveFocusRow {
  id: number;
  taskText: string;
  targetMinutes: number;
  startedAt: string;
  /** Derived on the server-side after the CTE resolves. */
  endsAt: string;
}

export interface InboxUnreadRow {
  id: number;
  text: string;
  capturedAt: string;
  source: string | null;
}

export interface PmAssignedRow {
  id: number;
  subject: string;
  projectIdentifier: string;
  projectName: string;
  /** Postgres `DATE` column — comes back as 'YYYY-MM-DD' (or Date in pglite). */
  dueDate: string | null;
  updatedAt: string;
  statusIsClosed: boolean;
  statusName: string;
}

export interface FocusTodayRow {
  totalMinutes: number;
  sessionCount: number;
}

export interface FocusHeatmapRow {
  /** Length-7 array, oldest first, daily focused-minute totals. */
  days: number[];
}

export interface RecentActivityRow {
  id: number;
  title: string;
  kind: string;
  createdAt: string;
}

export interface TodayPayload {
  me: MeRow;
  activeFocus: ActiveFocusRow | null;
  inboxUnread: InboxUnreadRow[];
  inboxCount: { unread: number };
  pmAssigned: PmAssignedRow[];
  focusToday: FocusTodayRow;
  focusHeatmap: FocusHeatmapRow;
  recentActivity: RecentActivityRow[];
}

export type OneNextActionKind =
  | 'focus'
  | 'overdue'
  | 'due-today'
  | 'inbox';

export interface OneNextAction {
  kind: OneNextActionKind;
  label: string;
  url: string;
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

/**
 * Probe a schema/relation existence so the planner never has to parse a
 * relation that doesn't exist on a freshly-deployed DB (the
 * `relation "X" does not exist` error is parse-time, not runtime — see the
 * inbox-probe rationale in focus' loadHomeImpl).  Dirt cheap on the same
 * Hyperdrive connection.
 */
async function probeRelation(db: DB, qualified: string): Promise<boolean> {
  const probe = (await db.execute(
    sql`SELECT to_regclass(${qualified}) IS NOT NULL AS exists`,
  )) as unknown;
  const [row] = rowsOf(probe);
  return Boolean((row as { exists?: boolean } | undefined)?.exists);
}

// ---------- The "one next action" picker ----------

/**
 * Algorithm (order of preference):
 *   1. Active focus session  → "go to focus"
 *   2. Overdue PM issue assigned to me (oldest first)
 *   3. PM issue assigned to me with due_date = today
 *   4. Top of inbox unread queue
 *   5. null — UI renders a warm empty state.
 *
 * Pure function; no DB calls.  Trivially unit-testable across each branch.
 */
export function pickOneNextAction(
  data: Pick<TodayPayload, 'activeFocus' | 'pmAssigned' | 'inboxUnread'>,
  now: Date = new Date(),
): OneNextAction | null {
  if (data.activeFocus) {
    return {
      kind: 'focus',
      label: data.activeFocus.taskText,
      url: 'https://focus.allenlabs.org/',
    };
  }
  // Overdue PM issue first.  We compare at day granularity (a due_date is a
  // calendar day, not a timestamp), so "due yesterday" is overdue at 00:00
  // local today.
  const overdue = data.pmAssigned.find(
    (i) =>
      i.dueDate != null &&
      !sameLocalDay(new Date(i.dueDate), now) &&
      new Date(i.dueDate).getTime() < now.getTime(),
  );
  if (overdue) {
    return {
      kind: 'overdue',
      label: overdue.subject,
      url: `https://projects.allenlabs.org/projects/${overdue.projectIdentifier}/issues/${overdue.id}`,
    };
  }
  const dueToday = data.pmAssigned.find(
    (i) => i.dueDate != null && sameLocalDay(new Date(i.dueDate), now),
  );
  if (dueToday) {
    return {
      kind: 'due-today',
      label: dueToday.subject,
      url: `https://projects.allenlabs.org/projects/${dueToday.projectIdentifier}/issues/${dueToday.id}`,
    };
  }
  if (data.inboxUnread.length > 0) {
    const top = data.inboxUnread[0]!;
    return {
      kind: 'inbox',
      label: truncate(top.text, 200),
      url: 'https://inbox.allenlabs.org/',
    };
  }
  return null;
}

// ---------- Loader (single CTE) ----------

/**
 * Pull every section of the dashboard in one round-trip.  We probe the
 * inbox.* and focus.* schemas first so the CTE doesn't reference relations
 * that haven't been migrated yet.  Two cheap probes + one big CTE.
 *
 * Returns null if `sub` is missing OR if no `pm.users` row maps the
 * Better-Auth subject (e.g. SSO not yet linked).
 */
export async function loadTodayImpl(
  db: DB,
  sub: string | null,
  now: Date = new Date(),
): Promise<TodayPayload | null> {
  if (!sub) return null;

  const haveInbox = await probeRelation(db, 'inbox.items');
  const haveFocus = await probeRelation(db, 'focus.sessions');

  const inboxUnreadCte = haveInbox
    ? sql`,
      inbox_unread AS (
        SELECT i.id, i.text, i.captured_at AS "capturedAt", i.source
        FROM inbox.items i
        WHERE i.user_id = (SELECT id FROM me) AND i.status = 'unread'
        ORDER BY i.captured_at DESC
        LIMIT 10
      ),
      inbox_count AS (
        SELECT COUNT(*)::int AS unread
        FROM inbox.items
        WHERE user_id = (SELECT id FROM me) AND status = 'unread'
      )`
    : sql``;

  const activeFocusCte = haveFocus
    ? sql`,
      active_focus AS (
        SELECT s.id,
               s.task_text      AS "taskText",
               s.target_minutes AS "targetMinutes",
               s.started_at     AS "startedAt"
        FROM focus.sessions s
        WHERE s.user_id = (SELECT id FROM me) AND s.ended_at IS NULL
        ORDER BY s.started_at DESC
        LIMIT 1
      ),
      focus_today AS (
        SELECT
          COALESCE(SUM(
            CASE WHEN ended_reason = 'completed' THEN target_minutes ELSE 0 END
          ), 0)::int AS "totalMinutes",
          COUNT(*)::int AS "sessionCount"
        FROM focus.sessions
        WHERE user_id = (SELECT id FROM me)
          AND started_at >= date_trunc('day', ${now.toISOString()}::timestamptz)
      ),
      heatmap_days AS (
        SELECT
          d::date AS day,
          COALESCE((
            SELECT SUM(
              CASE WHEN ended_reason = 'completed' THEN target_minutes ELSE 0 END
            )::int
            FROM focus.sessions
            WHERE user_id = (SELECT id FROM me)
              AND started_at >= d
              AND started_at < d + interval '1 day'
          ), 0) AS day_total
        FROM generate_series(
          date_trunc('day', ${now.toISOString()}::timestamptz - interval '6 days'),
          date_trunc('day', ${now.toISOString()}::timestamptz),
          interval '1 day'
        ) d
      )`
    : sql``;

  // PM tables are always present (pm is the source of truth) — no probe.
  const inboxUnreadJson = haveInbox
    ? sql`COALESCE((SELECT json_agg(row_to_json(t) ORDER BY t."capturedAt" DESC) FROM inbox_unread t), '[]'::json)`
    : sql`'[]'::json`;
  const inboxCountJson = haveInbox
    ? sql`(SELECT row_to_json(t) FROM inbox_count t)`
    : sql`json_build_object('unread', 0)`;
  const activeFocusJson = haveFocus
    ? sql`(SELECT row_to_json(t) FROM active_focus t)`
    : sql`NULL`;
  const focusTodayJson = haveFocus
    ? sql`(SELECT row_to_json(t) FROM focus_today t)`
    : sql`json_build_object('totalMinutes', 0, 'sessionCount', 0)`;
  const heatmapJson = haveFocus
    ? sql`json_build_object('days', COALESCE((SELECT json_agg(day_total ORDER BY day) FROM heatmap_days), '[]'::json))`
    : sql`json_build_object('days', '[0,0,0,0,0,0,0]'::json)`;

  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login, admin AS "isAdmin"
        FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      pm_assigned AS (
        SELECT i.id,
               i.subject,
               p.identifier AS "projectIdentifier",
               p.name       AS "projectName",
               i.due_date   AS "dueDate",
               i.updated_at AS "updatedAt",
               s.is_closed  AS "statusIsClosed",
               s.name       AS "statusName"
        FROM pm.issues i
        JOIN pm.projects p        ON p.id = i.project_id
        JOIN pm.issue_statuses s  ON s.id = i.status_id
        WHERE i.assigned_to_id = (SELECT id FROM me)
          AND s.is_closed = false
        ORDER BY
          (i.due_date IS NULL),
          i.due_date,
          i.updated_at DESC
        LIMIT 20
      ),
      recent_activity AS (
        SELECT a.id, a.title, a.kind, a.created_at AS "createdAt"
        FROM pm.activities a
        WHERE a.user_id = (SELECT id FROM me)
        ORDER BY a.created_at DESC
        LIMIT 10
      )${inboxUnreadCte}${activeFocusCte}
      SELECT json_build_object(
        'me',             (SELECT row_to_json(me) FROM me),
        'activeFocus',    ${activeFocusJson},
        'inboxUnread',    ${inboxUnreadJson},
        'inboxCount',     ${inboxCountJson},
        'pmAssigned',     COALESCE((SELECT json_agg(t) FROM pm_assigned t), '[]'::json),
        'focusToday',     ${focusTodayJson},
        'focusHeatmap',   ${heatmapJson},
        'recentActivity', COALESCE((SELECT json_agg(t) FROM recent_activity t), '[]'::json)
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const raw = (
    first as
      | {
          data?: {
            me: MeRow | null;
            activeFocus: (Omit<ActiveFocusRow, 'endsAt'> & { endsAt?: undefined }) | null;
            inboxUnread?: InboxUnreadRow[];
            inboxCount?: { unread: number };
            pmAssigned?: PmAssignedRow[];
            focusToday?: FocusTodayRow;
            focusHeatmap?: { days: number[] };
            recentActivity?: RecentActivityRow[];
          };
        }
      | undefined
  )?.data;
  if (!raw?.me) return null;

  // Normalise: postgres may return integer-typed counts as strings (pglite),
  // and the activeFocus row needs `endsAt` derived from
  // startedAt + targetMinutes.  Heatmap entries may be string-typed
  // numerics — coerce them to plain `number`.
  let activeFocus: ActiveFocusRow | null = null;
  if (raw.activeFocus) {
    const startedAt = new Date(raw.activeFocus.startedAt).getTime();
    const targetMinutes = Number(raw.activeFocus.targetMinutes);
    activeFocus = {
      id: Number(raw.activeFocus.id),
      taskText: raw.activeFocus.taskText,
      targetMinutes,
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + targetMinutes * 60_000).toISOString(),
    };
  }

  return {
    me: {
      id: Number(raw.me.id),
      login: raw.me.login,
      isAdmin: Boolean(raw.me.isAdmin),
    },
    activeFocus,
    /* v8 ignore start — `?? []` / `?? 0` / typeof-string fallbacks are
       defensive against driver quirks (postgres.js returns ISO strings
       for TIMESTAMPTZ, pglite returns Date; pg returns DATE as
       'YYYY-MM-DD' string and we don't exercise the Date branch under
       CI).  Same pattern as inbox/focus loadHomeImpl normalisers. */
    inboxUnread: (raw.inboxUnread ?? []).map((r) => ({
      id: Number(r.id),
      text: r.text,
      capturedAt: typeof r.capturedAt === 'string' ? r.capturedAt : new Date(r.capturedAt).toISOString(),
      source: r.source ?? null,
    })),
    inboxCount: { unread: Number(raw.inboxCount?.unread ?? 0) },
    pmAssigned: (raw.pmAssigned ?? []).map((r) => ({
      id: Number(r.id),
      subject: r.subject,
      projectIdentifier: r.projectIdentifier,
      projectName: r.projectName,
      dueDate:
        r.dueDate == null
          ? null
          : typeof r.dueDate === 'string'
            ? r.dueDate
            : (r.dueDate as Date).toISOString().slice(0, 10),
      updatedAt:
        typeof r.updatedAt === 'string' ? r.updatedAt : new Date(r.updatedAt).toISOString(),
      statusIsClosed: Boolean(r.statusIsClosed),
      statusName: r.statusName,
    })),
    focusToday: {
      totalMinutes: Number(raw.focusToday?.totalMinutes ?? 0),
      sessionCount: Number(raw.focusToday?.sessionCount ?? 0),
    },
    focusHeatmap: {
      days: (raw.focusHeatmap?.days ?? [0, 0, 0, 0, 0, 0, 0]).map((n) => Number(n)),
    },
    recentActivity: (raw.recentActivity ?? []).map((r) => ({
      id: Number(r.id),
      title: r.title,
      kind: r.kind,
      createdAt:
        typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
    })),
    /* v8 ignore stop */
  };
}
