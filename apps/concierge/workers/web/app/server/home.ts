// Home page loader.  One round-trip: pulls `me`, recent nudges, and
// preferences in a single CTE.

import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';
import {
  DEFAULT_PREFERENCES,
  type NudgeRow,
  type PreferencesRow,
} from './concierge';

export interface HomePayload {
  me: { id: number; login: string };
  nudges: NudgeRow[];
  preferences: PreferencesRow;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch in
     tests; the plain-array path hits in production via postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  /* v8 ignore next — pglite + postgres.js return ISO strings for timestamps
     in this CTE; the Date branch is defensive. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — only fires on a malformed input the DB can't produce. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function parseChannels(raw: unknown): NudgeRow['channels'] {
  /* v8 ignore next 2 — both drivers parse jsonb to a real array. */
  const arr = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  /* v8 ignore next — `channels` column is NOT NULL default '[]'::jsonb. */
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (v): v is 'push' | 'today' | 'email' =>
      v === 'push' || v === 'today' || v === 'email',
  );
}

export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  limit = 20,
): Promise<HomePayload | null> {
  if (!sub) return null;
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_nudges AS (
        SELECT
          id,
          user_id,
          topic,
          question,
          context_summary,
          model,
          channels,
          sent_at,
          opened_at,
          dismissed_at,
          replied_at,
          reply_text
        FROM concierge.nudges
        WHERE user_id = (SELECT id FROM me)
        ORDER BY sent_at DESC
        LIMIT ${capped}
      ),
      my_prefs AS (
        SELECT
          user_id,
          enabled,
          quiet_start,
          quiet_end,
          cadence_minutes,
          last_nudge_at,
          updated_at
        FROM concierge.preferences
        WHERE user_id = (SELECT id FROM me)
        LIMIT 1
      )
      SELECT json_build_object(
        'me',          (SELECT row_to_json(me) FROM me),
        'nudges',      COALESCE(
          (SELECT json_agg(json_build_object(
              'id',             id,
              'userId',         user_id,
              'topic',          topic,
              'question',       question,
              'contextSummary', context_summary,
              'model',          model,
              'channels',       channels,
              'sentAt',         sent_at,
              'openedAt',       opened_at,
              'dismissedAt',    dismissed_at,
              'repliedAt',      replied_at,
              'replyText',      reply_text
            ) ORDER BY sent_at DESC) FROM my_nudges),
          '[]'::json
        ),
        'preferences', (SELECT row_to_json(my_prefs) FROM my_prefs)
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as {
    data?: {
      me: { id: number; login: string } | null;
      nudges?: Array<{
        id: number; userId: number; topic: string; question: string;
        contextSummary: string | null; model: string | null;
        channels: unknown;
        sentAt: Date | string;
        openedAt: Date | string | null;
        dismissedAt: Date | string | null;
        repliedAt: Date | string | null;
        replyText: string | null;
      }>;
      preferences?: {
        user_id: number; enabled: boolean;
        quiet_start: number | null; quiet_end: number | null;
        cadence_minutes: number;
        last_nudge_at: Date | string | null;
        updated_at: Date | string;
      } | null;
    };
  } | undefined)?.data;
  if (!data?.me) return null;
  const preferences: PreferencesRow = data.preferences
    ? {
        userId: Number(data.preferences.user_id),
        enabled: Boolean(data.preferences.enabled),
        quietStart:
          data.preferences.quiet_start != null
            ? Number(data.preferences.quiet_start)
            : null,
        quietEnd:
          data.preferences.quiet_end != null
            ? Number(data.preferences.quiet_end)
            : null,
        cadenceMinutes: Number(data.preferences.cadence_minutes),
        lastNudgeAt: toIsoOrNull(data.preferences.last_nudge_at),
        /* v8 ignore next — updated_at NOT NULL default now(). */
        updatedAt: toIsoOrNull(data.preferences.updated_at) ?? new Date().toISOString(),
      }
    : {
        userId: data.me.id,
        ...DEFAULT_PREFERENCES,
        updatedAt: new Date().toISOString(),
      };
  return {
    me: data.me,
    /* v8 ignore next — `?? []` defensive; the CTE COALESCEs to []. */
    nudges: (data.nudges ?? []).map((n) => ({
      id: Number(n.id),
      userId: Number(n.userId),
      topic: n.topic,
      question: n.question,
      contextSummary: n.contextSummary,
      model: n.model,
      channels: parseChannels(n.channels),
      sentAt: toIsoOrNull(n.sentAt)!,
      openedAt: toIsoOrNull(n.openedAt),
      dismissedAt: toIsoOrNull(n.dismissedAt),
      repliedAt: toIsoOrNull(n.repliedAt),
      replyText: n.replyText,
    })),
    preferences,
  };
}
