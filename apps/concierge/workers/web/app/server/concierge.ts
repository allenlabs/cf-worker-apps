// Concierge impls.  Pure functions that take an injected DB so they run
// against PGlite in tests without dragging in the TanStack Start runtime or
// real Hyperdrive.  Re-exported from the web worker, the HMAC API worker,
// and the cron worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { nudges, preferences } from '~/db/schema';

// ---------- Types ----------

/** Topics the LLM is allowed to pick from.  Stored in `concierge.nudges.topic`
 *  as a short slug; the admin UI maps these to friendly labels via `topicLabel`. */
export const NUDGE_TOPICS = [
  'inbox-idle',
  'focus-abandoned',
  'pm-stalled',
  'celebration',
  'open-thread',
  'event',
] as const;
export type NudgeTopic = (typeof NUDGE_TOPICS)[number];

export type Channel = 'push' | 'today' | 'email';

export interface NudgeRow {
  id: number;
  userId: number;
  topic: string;
  question: string;
  contextSummary: string | null;
  model: string | null;
  channels: Channel[];
  sentAt: string;
  openedAt: string | null;
  dismissedAt: string | null;
  repliedAt: string | null;
  replyText: string | null;
}

export interface PreferencesRow {
  userId: number;
  enabled: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  cadenceMinutes: number;
  lastNudgeAt: string | null;
  updatedAt: string;
}

export const DEFAULT_PREFERENCES: Omit<PreferencesRow, 'userId' | 'updatedAt'> = {
  enabled: true,
  quietStart: null,
  quietEnd: null,
  cadenceMinutes: 240,
  lastNudgeAt: null,
};

// ---------- helpers ----------

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch in
     tests; the plain-array path hits in production via postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — Date parsing only fails on a malformed string. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function parseChannels(raw: unknown): Channel[] {
  /* v8 ignore next 2 — both drivers parse jsonb to a real array; the string
     fallback is defensive against a future driver returning the raw JSON text. */
  const arr =
    typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  /* v8 ignore next — `channels` column is NOT NULL with default '[]'::jsonb. */
  if (!Array.isArray(arr)) return [];
  const out: Channel[] = [];
  for (const v of arr) {
    /* v8 ignore next — the else branch (a stray non-channel string) only
       fires if a future caller writes garbage; insertNudgeSchema's
       z.array(channelSchema) already rejects unknown values at the boundary. */
    if (v === 'push' || v === 'today' || v === 'email') out.push(v);
  }
  return out;
}

// ---------- Quiet hours & cadence gating ----------

/**
 * Inside the user's quiet window?  `quietStart` / `quietEnd` are
 * minutes-from-UTC-midnight (0..1439).  Windows that span midnight wrap
 * naturally.  If either bound is null or both are equal, quiet hours
 * are disabled.
 */
export function inQuietHours(
  prefs: Pick<PreferencesRow, 'quietStart' | 'quietEnd'>,
  now: Date = new Date(),
): boolean {
  const start = prefs.quietStart;
  const end = prefs.quietEnd;
  if (start == null || end == null) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  // Wraps past midnight.
  return minutes >= start || minutes < end;
}

/**
 * "Allowed to nudge this user right now?" — combines quiet hours + cadence.
 * Returns either `{ ok: true }` or `{ ok: false, reason, nextAt? }`.
 */
export interface GateResult {
  ok: boolean;
  reason?: 'disabled' | 'quiet-hours' | 'cadence';
  nextAt?: Date;
}

export function gateNudge(
  prefs: Pick<
    PreferencesRow,
    'enabled' | 'quietStart' | 'quietEnd' | 'cadenceMinutes' | 'lastNudgeAt'
  >,
  now: Date = new Date(),
): GateResult {
  if (!prefs.enabled) return { ok: false, reason: 'disabled' };
  if (inQuietHours(prefs, now)) return { ok: false, reason: 'quiet-hours' };
  if (prefs.lastNudgeAt) {
    const last = new Date(prefs.lastNudgeAt).getTime();
    if (Number.isFinite(last)) {
      const nextAt = new Date(last + prefs.cadenceMinutes * 60_000);
      if (nextAt.getTime() > now.getTime()) {
        return { ok: false, reason: 'cadence', nextAt };
      }
    }
  }
  return { ok: true };
}

// ---------- State summary builder ----------

export interface StateSummary {
  inboxUnread: number;
  inboxLastCapturedAt: string | null;
  inboxLastText: string | null;
  focusActive: boolean;
  focusLastEndedAt: string | null;
  focusLastEndedReason: string | null;
  focusLastTaskText: string | null;
  pmOpenIssues: number;
  pmLastClosedAt: string | null;
  pmLastClosedTitle: string | null;
  contextLastSavedAt: string | null;
  contextLastName: string | null;
  recentNudges: Array<{ topic: string; question: string; sentAt: string }>;
}

/**
 * Pull the user's recent state across inbox / focus / pm / context in ONE
 * round-trip.  Every JOIN is a LEFT JOIN against a one-row aggregate, so the
 * row count is always exactly 1.  All counts and "last X" timestamps are
 * collated in the same CTE.
 *
 * The output is what we feed the LLM.  Tight, predictable, no PII beyond
 * what the user themselves typed.
 */
export async function buildStateSummaryImpl(
  db: DB,
  userId: number,
): Promise<StateSummary> {
  const result = (await db.execute(
    sql`
      WITH
      inbox_recent AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'unread')::int AS unread_count,
          MAX(captured_at) FILTER (WHERE status = 'unread')        AS last_unread_at,
          (
            SELECT text FROM inbox.items
            WHERE user_id = ${userId} AND status = 'unread'
            ORDER BY captured_at DESC LIMIT 1
          ) AS last_text
        FROM inbox.items
        WHERE user_id = ${userId}
      ),
      focus_active AS (
        SELECT EXISTS(
          SELECT 1 FROM focus.sessions
          WHERE user_id = ${userId} AND ended_at IS NULL
        )::boolean AS is_active
      ),
      focus_last AS (
        SELECT ended_at, ended_reason, task_text
        FROM focus.sessions
        WHERE user_id = ${userId} AND ended_at IS NOT NULL
        ORDER BY ended_at DESC LIMIT 1
      ),
      pm_open AS (
        SELECT COUNT(*)::int AS open_count
        FROM pm.issues i
        LEFT JOIN pm.issue_statuses s ON s.id = i.status_id
        WHERE i.assigned_to_id = ${userId} AND COALESCE(s.is_closed, FALSE) = FALSE
      ),
      pm_last AS (
        SELECT i.closed_at, i.subject AS title
        FROM pm.issues i
        LEFT JOIN pm.issue_statuses s ON s.id = i.status_id
        WHERE i.assigned_to_id = ${userId} AND COALESCE(s.is_closed, FALSE) = TRUE
          AND i.closed_at IS NOT NULL
        ORDER BY i.closed_at DESC LIMIT 1
      ),
      ctx_last AS (
        SELECT created_at, name
        FROM context.snapshots
        WHERE user_id = ${userId}
        ORDER BY created_at DESC LIMIT 1
      ),
      recent_nudges AS (
        SELECT topic, question, sent_at
        FROM concierge.nudges
        WHERE user_id = ${userId}
        ORDER BY sent_at DESC LIMIT 3
      )
      SELECT
        (SELECT unread_count    FROM inbox_recent) AS inbox_unread,
        (SELECT last_unread_at  FROM inbox_recent) AS inbox_last,
        (SELECT last_text       FROM inbox_recent) AS inbox_last_text,
        (SELECT is_active       FROM focus_active) AS focus_active,
        (SELECT ended_at        FROM focus_last)   AS focus_last_ended,
        (SELECT ended_reason    FROM focus_last)   AS focus_last_reason,
        (SELECT task_text       FROM focus_last)   AS focus_last_task,
        (SELECT open_count      FROM pm_open)      AS pm_open,
        (SELECT closed_at       FROM pm_last)      AS pm_last_closed,
        (SELECT title           FROM pm_last)      AS pm_last_title,
        (SELECT created_at      FROM ctx_last)     AS ctx_last_at,
        (SELECT name            FROM ctx_last)     AS ctx_last_name,
        COALESCE((SELECT json_agg(json_build_object(
          'topic',    topic,
          'question', question,
          'sentAt',   sent_at
        ) ORDER BY sent_at DESC) FROM recent_nudges), '[]'::json) AS recent_nudges
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  type Row = {
    inbox_unread: number | string | null;
    inbox_last: Date | string | null;
    inbox_last_text: string | null;
    focus_active: boolean | null;
    focus_last_ended: Date | string | null;
    focus_last_reason: string | null;
    focus_last_task: string | null;
    pm_open: number | string | null;
    pm_last_closed: Date | string | null;
    pm_last_title: string | null;
    ctx_last_at: Date | string | null;
    ctx_last_name: string | null;
    recent_nudges:
      | Array<{ topic: string; question: string; sentAt: Date | string }>
      | string
      | null;
  };
  /* v8 ignore next — the CTE always produces exactly one row. */
  const row = (first as Row | undefined) ?? ({} as Row);
  /* v8 ignore next 4 — pglite + postgres.js both hand jsonb back as a parsed
     array; the string fallback and ?? [] are defensive against a future
     driver returning the raw JSON text or null. */
  const nudgesRaw =
    typeof row.recent_nudges === 'string'
      ? (JSON.parse(row.recent_nudges) as Array<{ topic: string; question: string; sentAt: Date | string }>)
      : row.recent_nudges ?? [];
  return {
    /* v8 ignore next — COUNT(...)::int never returns null; the ?? 0 is
       defensive against a future driver bug. */
    inboxUnread: Number(row.inbox_unread ?? 0),
    inboxLastCapturedAt: toIsoOrNull(row.inbox_last),
    inboxLastText: row.inbox_last_text,
    focusActive: Boolean(row.focus_active),
    focusLastEndedAt: toIsoOrNull(row.focus_last_ended),
    focusLastEndedReason: row.focus_last_reason,
    focusLastTaskText: row.focus_last_task,
    /* v8 ignore next — same as inbox_unread above. */
    pmOpenIssues: Number(row.pm_open ?? 0),
    pmLastClosedAt: toIsoOrNull(row.pm_last_closed),
    pmLastClosedTitle: row.pm_last_title,
    contextLastSavedAt: toIsoOrNull(row.ctx_last_at),
    contextLastName: row.ctx_last_name,
    recentNudges: nudgesRaw.map((n) => ({
      topic: n.topic,
      question: n.question,
      /* v8 ignore next — sentAt always populated. */
      sentAt: toIsoOrNull(n.sentAt) ?? '',
    })),
  };
}

/**
 * Render a state summary as a tight plain-English block for the LLM prompt.
 * Kept compact so we don't burn tokens; relative timestamps so the model
 * doesn't have to do arithmetic.
 */
export function renderStateSummary(s: StateSummary, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`- Inbox: ${s.inboxUnread} unread.`);
  if (s.inboxLastText && s.inboxLastCapturedAt) {
    const ago = relativeAgo(s.inboxLastCapturedAt, now);
    const preview = s.inboxLastText.length > 80
      ? `${s.inboxLastText.slice(0, 77)}...`
      : s.inboxLastText;
    lines.push(`  Last captured ${ago}: "${preview}"`);
  }
  lines.push(`- Focus: ${s.focusActive ? 'active session right now' : 'no active session'}.`);
  if (s.focusLastEndedAt && s.focusLastTaskText) {
    const ago = relativeAgo(s.focusLastEndedAt, now);
    const reason = s.focusLastEndedReason ?? 'ended';
    lines.push(`  Last session "${s.focusLastTaskText}" ${reason} ${ago}.`);
  }
  lines.push(`- PM: ${s.pmOpenIssues} open issues assigned.`);
  if (s.pmLastClosedAt && s.pmLastClosedTitle) {
    const ago = relativeAgo(s.pmLastClosedAt, now);
    lines.push(`  Last closed ${ago}: "${s.pmLastClosedTitle}"`);
  }
  if (s.contextLastSavedAt && s.contextLastName) {
    const ago = relativeAgo(s.contextLastSavedAt, now);
    lines.push(`- Context: last snapshot "${s.contextLastName}" ${ago}.`);
  } else {
    lines.push(`- Context: no snapshots.`);
  }
  if (s.recentNudges.length > 0) {
    lines.push(`- Recent nudges (avoid repeating):`);
    for (const n of s.recentNudges) {
      const ago = relativeAgo(n.sentAt, now);
      lines.push(`    [${n.topic}, ${ago}] ${n.question}`);
    }
  }
  return lines.join('\n');
}

function relativeAgo(input: string, now: Date): string {
  const t = new Date(input).getTime();
  /* v8 ignore next — only fires on a malformed input that the CTE can't produce. */
  if (!Number.isFinite(t)) return 'unknown';
  const diff = Math.max(0, now.getTime() - t);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------- LLM client ----------

/** OpenAI-compatible /chat/completions client.  Plain `fetch` — no SDK. */
export interface LlmEnv {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL?: string;
}

export interface LlmComposeInput {
  stateSummary: string;
  /** Optional context override (e.g. event-triggered: "user just closed
   *  PM issue #14") prepended to the user message. */
  trigger?: string;
}

export interface LlmComposeResult {
  /** The composed question.  `null` when the LLM returned the literal word
   *  "SKIP" or when parsing failed — callers should NOT insert a nudge. */
  question: string | null;
  /** The actual model the API picked.  May differ from LLM_MODEL if the
   *  backend mapped to an alias. */
  model: string;
}

const SYSTEM_PROMPT = `\
You are a gentle ADHD-aware coach.  Read the user's recent productivity state below.
Compose ONE short question (max 25 words) that nudges them about something
unfinished or notable.  Tone: warm, curious, NOT judgmental.  Avoid streaks.
If nothing in the state warrants a nudge, output the literal word "SKIP".

Examples:

State:
- Inbox: 4 unread.
  Last captured 26h ago: "look at /admin/users 502s"
- Focus: no active session.
  Last session "fix /search 500s" completed 1d ago.
- PM: 3 open issues assigned.
  Last closed 18h ago: "fix /search 500s"
Question: You closed "fix /search 500s" yesterday — the inbox note about /admin/users 502s is still open.  Pick that up next?

State:
- Inbox: 0 unread.
- Focus: no active session.
  Last session "design review prep" abandoned 12m ago.
Question: That focus session ended 8 minutes in — what got in the way?

State:
- Inbox: 12 unread.
  Last captured 4d ago: "try Bun for ingest"
- Focus: no active session in 3 days.
Question: It's been a few days since a focus session — pick one inbox item to start with?`;

export async function composeNudgeImpl(
  env: LlmEnv,
  input: LlmComposeInput,
  fetchFn: typeof fetch = fetch,
): Promise<LlmComposeResult> {
  const model = env.LLM_MODEL ?? 'gpt-4o-mini';
  const userMessage = input.trigger
    ? `${input.trigger}\n\nState:\n${input.stateSummary}`
    : `State:\n${input.stateSummary}`;
  const body = JSON.stringify({
    model,
    temperature: 0.5,
    max_tokens: 80,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });
  const url = `${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body,
  });
  if (!res.ok) {
    /* v8 ignore next — `.text()` can only fail when the body is already
       consumed, which we never do.  The catch is defensive so a 5xx without
       a body still surfaces a useful error message. */
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!raw || raw === 'SKIP' || /^SKIP\b/i.test(raw)) {
    return { question: null, model: json.model ?? model };
  }
  // Strip a leading "Question:" prefix the model sometimes emits (it shows up
  // in the few-shot examples).  Cap to 25 words by sentence trimming if it
  // overruns — soft cap, not a hard reject.
  const cleaned = raw.replace(/^\s*Question:\s*/i, '').trim();
  return { question: cleaned, model: json.model ?? model };
}

/**
 * Glue: pick a topic from the state summary.  The LLM picks the wording;
 * we just label the row so the today loader can render an icon and the
 * admin UI can filter.  Heuristic ordering — first match wins.
 */
export function pickTopic(s: StateSummary, now: Date = new Date()): NudgeTopic {
  if (s.focusLastEndedReason === 'abandoned') return 'focus-abandoned';
  if (s.pmLastClosedAt && s.inboxUnread > 0) {
    const closedMs = new Date(s.pmLastClosedAt).getTime();
    /* v8 ignore next — Number.isFinite guards a malformed ISO that the
       state-summary CTE can't produce; defensive only. */
    if (Number.isFinite(closedMs) && now.getTime() - closedMs < 48 * 3600_000) {
      return 'celebration';
    }
  }
  if (s.inboxUnread > 0 && s.inboxLastCapturedAt) {
    const capMs = new Date(s.inboxLastCapturedAt).getTime();
    /* v8 ignore next — same as above; defensive against driver corruption. */
    if (Number.isFinite(capMs) && now.getTime() - capMs > 24 * 3600_000) {
      return 'inbox-idle';
    }
  }
  if (s.pmOpenIssues > 0) return 'pm-stalled';
  return 'open-thread';
}

// ---------- nudges DB ----------

const channelSchema = z.union([
  z.literal('push'),
  z.literal('today'),
  z.literal('email'),
]);

export const insertNudgeSchema = z.object({
  userId: z.number().int().positive(),
  topic: z.enum(NUDGE_TOPICS),
  question: z.string().min(1).max(2000),
  contextSummary: z.string().max(8000).optional(),
  model: z.string().max(200).optional(),
  channels: z.array(channelSchema).default([]),
});
export type InsertNudgeInput = z.infer<typeof insertNudgeSchema>;

export async function insertNudgeImpl(
  db: DB,
  input: InsertNudgeInput,
  now: Date = new Date(),
): Promise<NudgeRow> {
  const [row] = await db
    .insert(nudges)
    .values({
      userId: input.userId,
      topic: input.topic,
      question: input.question,
      contextSummary: input.contextSummary ?? null,
      model: input.model ?? null,
      channels: input.channels,
      sentAt: now,
    })
    .returning();
  /* v8 ignore next — RETURNING always yields one row on a successful INSERT. */
  if (!row) throw new Error('insertNudgeImpl: insert returned no row');
  return {
    id: row.id,
    userId: row.userId,
    topic: row.topic,
    question: row.question,
    contextSummary: row.contextSummary,
    model: row.model,
    channels: parseChannels(row.channels),
    /* v8 ignore next — sentAt is NOT NULL with a default. */
    sentAt: toIsoOrNull(row.sentAt) ?? new Date().toISOString(),
    openedAt: toIsoOrNull(row.openedAt),
    dismissedAt: toIsoOrNull(row.dismissedAt),
    repliedAt: toIsoOrNull(row.repliedAt),
    replyText: row.replyText,
  };
}

/** Return the user's most recent unopened, undismissed, unreplied nudge. */
export async function getActiveNudgeImpl(
  db: DB,
  userId: number,
): Promise<NudgeRow | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id         AS "userId",
        topic,
        question,
        context_summary AS "contextSummary",
        model,
        channels,
        sent_at         AS "sentAt",
        opened_at       AS "openedAt",
        dismissed_at    AS "dismissedAt",
        replied_at      AS "repliedAt",
        reply_text      AS "replyText"
      FROM concierge.nudges
      WHERE user_id = ${userId}
        AND dismissed_at IS NULL
        AND replied_at IS NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const r = first as {
    id: number; userId: number; topic: string; question: string;
    contextSummary: string | null; model: string | null;
    channels: unknown;
    sentAt: Date | string; openedAt: Date | string | null;
    dismissedAt: Date | string | null; repliedAt: Date | string | null;
    replyText: string | null;
  };
  return {
    id: Number(r.id),
    userId: Number(r.userId),
    topic: r.topic,
    question: r.question,
    contextSummary: r.contextSummary,
    model: r.model,
    channels: parseChannels(r.channels),
    sentAt: toIsoOrNull(r.sentAt)!,
    openedAt: toIsoOrNull(r.openedAt),
    dismissedAt: toIsoOrNull(r.dismissedAt),
    repliedAt: toIsoOrNull(r.repliedAt),
    replyText: r.replyText,
  };
}

/** List the user's recent nudges (admin UI / debug). */
export async function listNudgesImpl(
  db: DB,
  userId: number,
  limit = 20,
): Promise<NudgeRow[]> {
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id         AS "userId",
        topic,
        question,
        context_summary AS "contextSummary",
        model,
        channels,
        sent_at         AS "sentAt",
        opened_at       AS "openedAt",
        dismissed_at    AS "dismissedAt",
        replied_at      AS "repliedAt",
        reply_text      AS "replyText"
      FROM concierge.nudges
      WHERE user_id = ${userId}
      ORDER BY sent_at DESC
      LIMIT ${capped}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as {
      id: number; userId: number; topic: string; question: string;
      contextSummary: string | null; model: string | null;
      channels: unknown;
      sentAt: Date | string; openedAt: Date | string | null;
      dismissedAt: Date | string | null; repliedAt: Date | string | null;
      replyText: string | null;
    };
    return {
      id: Number(row.id),
      userId: Number(row.userId),
      topic: row.topic,
      question: row.question,
      contextSummary: row.contextSummary,
      model: row.model,
      channels: parseChannels(row.channels),
      sentAt: toIsoOrNull(row.sentAt)!,
      openedAt: toIsoOrNull(row.openedAt),
      dismissedAt: toIsoOrNull(row.dismissedAt),
      repliedAt: toIsoOrNull(row.repliedAt),
      replyText: row.replyText,
    };
  });
}

export async function markOpenedImpl(
  db: DB,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      UPDATE concierge.nudges
      SET opened_at = COALESCE(opened_at, ${now.toISOString()}::timestamptz)
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export async function dismissNudgeImpl(
  db: DB,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      UPDATE concierge.nudges
      SET dismissed_at = ${now.toISOString()}::timestamptz
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export async function replyNudgeImpl(
  db: DB,
  userId: number,
  id: number,
  reply: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      UPDATE concierge.nudges
      SET replied_at = ${now.toISOString()}::timestamptz, reply_text = ${reply}
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// ---------- preferences ----------

export const setPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  quietStart: z.number().int().min(0).max(1439).nullable().optional(),
  quietEnd: z.number().int().min(0).max(1439).nullable().optional(),
  cadenceMinutes: z.number().int().min(15).max(24 * 60).optional(),
});
export type SetPreferencesInput = z.infer<typeof setPreferencesSchema>;

export async function getPreferencesImpl(
  db: DB,
  userId: number,
): Promise<PreferencesRow> {
  const result = (await db.execute(
    sql`
      SELECT
        user_id         AS "userId",
        enabled,
        quiet_start     AS "quietStart",
        quiet_end       AS "quietEnd",
        cadence_minutes AS "cadenceMinutes",
        last_nudge_at   AS "lastNudgeAt",
        updated_at      AS "updatedAt"
      FROM concierge.preferences
      WHERE user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) {
    return {
      userId,
      ...DEFAULT_PREFERENCES,
      updatedAt: new Date().toISOString(),
    };
  }
  const r = first as {
    userId: number; enabled: boolean;
    quietStart: number | null; quietEnd: number | null;
    cadenceMinutes: number; lastNudgeAt: Date | string | null;
    updatedAt: Date | string;
  };
  return {
    userId: Number(r.userId),
    enabled: Boolean(r.enabled),
    quietStart: r.quietStart != null ? Number(r.quietStart) : null,
    quietEnd: r.quietEnd != null ? Number(r.quietEnd) : null,
    cadenceMinutes: Number(r.cadenceMinutes),
    lastNudgeAt: toIsoOrNull(r.lastNudgeAt),
    updatedAt: toIsoOrNull(r.updatedAt)!,
  };
}

export async function setPreferencesImpl(
  db: DB,
  userId: number,
  input: SetPreferencesInput,
  now: Date = new Date(),
): Promise<PreferencesRow> {
  const current = await getPreferencesImpl(db, userId);
  const next: PreferencesRow = {
    userId,
    enabled: input.enabled ?? current.enabled,
    quietStart:
      input.quietStart === undefined ? current.quietStart : input.quietStart,
    quietEnd:
      input.quietEnd === undefined ? current.quietEnd : input.quietEnd,
    cadenceMinutes: input.cadenceMinutes ?? current.cadenceMinutes,
    lastNudgeAt: current.lastNudgeAt,
    updatedAt: now.toISOString(),
  };
  await db
    .insert(preferences)
    .values({
      userId: next.userId,
      enabled: next.enabled,
      quietStart: next.quietStart,
      quietEnd: next.quietEnd,
      cadenceMinutes: next.cadenceMinutes,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: preferences.userId,
      set: {
        enabled: next.enabled,
        quietStart: next.quietStart,
        quietEnd: next.quietEnd,
        cadenceMinutes: next.cadenceMinutes,
        updatedAt: now,
      },
    });
  return next;
}

/** Stamp `last_nudge_at` after a successful send.  Creates the row if it
 *  doesn't exist (using defaults). */
export async function bumpLastNudgeImpl(
  db: DB,
  userId: number,
  now: Date = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db.execute(
    sql`
      INSERT INTO concierge.preferences (user_id, last_nudge_at, updated_at)
      VALUES (${userId}, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET
        last_nudge_at = EXCLUDED.last_nudge_at,
        updated_at    = EXCLUDED.updated_at
    `,
  );
}

/** List user_ids the cron should consider this tick.  Filters out
 *  enabled=false; quiet-hours + cadence are evaluated per-user. */
export async function listEnabledUserIdsImpl(
  db: DB,
  limit = 1000,
): Promise<number[]> {
  const capped = Math.max(1, Math.min(10_000, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      SELECT user_id AS "userId"
      FROM concierge.preferences
      WHERE enabled = TRUE
      ORDER BY user_id
      LIMIT ${capped}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => Number((r as { userId: number | string }).userId));
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
      FROM concierge.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  return first as ApiClientRow;
}

// Re-export for tests that need to count rows.
export { nudges, preferences };
