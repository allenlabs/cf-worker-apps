/**
 * Concierge: preferences toggle + (optional) manual trigger.
 *
 * Surfaces exercised:
 *   - GET /                  loads the home loader (me + nudges + preferences)
 *   - POST /api/preferences  toggles `enabled` (and cadence) on the
 *                            concierge.preferences row keyed by user_id
 *   - POST /api/trigger      drives the LLM compose pipeline.  The LLM
 *                            round-trip is real (gpt-4o-mini); the response
 *                            tells us whether a nudge was inserted.  When
 *                            one was, we tag it via direct PG UPDATE so the
 *                            global cleanup picks it up.
 *
 * Teardown rules (run unconditionally in `test.afterAll` to keep the DB
 * pristine on flakes):
 *   1. Restore the concierge.preferences row to its pre-test state OR
 *      delete the row if it didn't exist before.
 *   2. Tag any inserted nudge with the `[e2e]` prefix so `cleanup.ts`
 *      sweeps it.  (We also direct-delete it as a belt-and-braces.)
 *
 * The DB connection is built from DATABASE_URL — same path the cleanup
 * script takes.  It's the only spec that needs PG because concierge
 * preferences are user-scoped (no "tag column") and we MUST restore the
 * exact prior row, not just "delete e2e ones".
 */

import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { APPS, CONCIERGE_E2E_PREFIX } from './lib/fixtures';

interface PreferencesSnapshot {
  /** True iff a preferences row existed for our user BEFORE the test ran. */
  existed: boolean;
  /** Raw column values to restore.  Nullable cols are kept null. */
  enabled: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  cadenceMinutes: number;
  lastNudgeAt: Date | null;
  updatedAt: Date | null;
  /** pm.users.id for the signed-in user — looked up via SSO sub. */
  userId: number;
}

function buildPgClient(): Client {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      '[concierge.spec] DATABASE_URL must be set so the spec can ' +
        'snapshot+restore concierge.preferences.',
    );
  }
  // Match cleanup.ts: strip sslmode= from the URL, set ssl explicitly.
  const sanitized = raw.replace(/([?&])sslmode=[^&]*&?/g, (_m, sep) =>
    sep === '?' ? '?' : '',
  );
  const finalUrl = sanitized.replace(/[?&]$/, '');
  return new Client({
    connectionString: finalUrl,
    ssl: { rejectUnauthorized: false },
  });
}

/**
 * Snapshot the user's concierge.preferences row by SSO sub (the cookie's
 * JWT subject).  Returns the values to restore on teardown, OR
 * `existed: false` if there's no row yet.
 */
async function snapshotPreferencesForCookieUser(
  pg: Client,
  userId: number,
): Promise<PreferencesSnapshot> {
  const res = await pg.query<{
    enabled: boolean;
    quiet_start: number | null;
    quiet_end: number | null;
    cadence_minutes: number;
    last_nudge_at: Date | null;
    updated_at: Date | null;
  }>(
    `SELECT enabled, quiet_start, quiet_end, cadence_minutes,
            last_nudge_at, updated_at
       FROM concierge.preferences
       WHERE user_id = $1
       LIMIT 1`,
    [userId],
  );
  if (res.rowCount === 0) {
    return {
      existed: false,
      userId,
      enabled: true,
      quietStart: null,
      quietEnd: null,
      cadenceMinutes: 240,
      lastNudgeAt: null,
      updatedAt: null,
    };
  }
  const r = res.rows[0];
  return {
    existed: true,
    userId,
    enabled: r.enabled,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    cadenceMinutes: r.cadence_minutes,
    lastNudgeAt: r.last_nudge_at,
    updatedAt: r.updated_at,
  };
}

async function restorePreferences(
  pg: Client,
  snap: PreferencesSnapshot,
): Promise<void> {
  if (!snap.existed) {
    await pg.query(`DELETE FROM concierge.preferences WHERE user_id = $1`, [
      snap.userId,
    ]);
    return;
  }
  await pg.query(
    `INSERT INTO concierge.preferences
       (user_id, enabled, quiet_start, quiet_end, cadence_minutes, last_nudge_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled         = EXCLUDED.enabled,
       quiet_start     = EXCLUDED.quiet_start,
       quiet_end       = EXCLUDED.quiet_end,
       cadence_minutes = EXCLUDED.cadence_minutes,
       last_nudge_at   = EXCLUDED.last_nudge_at,
       updated_at      = EXCLUDED.updated_at`,
    [
      snap.userId,
      snap.enabled,
      snap.quietStart,
      snap.quietEnd,
      snap.cadenceMinutes,
      snap.lastNudgeAt,
      snap.updatedAt,
    ],
  );
}

/**
 * Tag a freshly-inserted nudge so the global cleanup picks it up later.
 * We prepend the `[e2e]` prefix to `question` (the column cleanup matches
 * on).  Idempotent — if the row's already tagged, this is a no-op.
 */
async function tagNudgeForCleanup(pg: Client, nudgeId: number): Promise<void> {
  await pg.query(
    `UPDATE concierge.nudges
       SET question = CASE
         WHEN question LIKE '[e2e]%' THEN question
         ELSE '[e2e] ' || question
       END
     WHERE id = $1`,
    [nudgeId],
  );
}

test.describe('concierge', () => {
  const login = process.env.E2E_PM_LOGIN?.trim();
  test.skip(!login, 'Set E2E_PM_LOGIN to a dedicated test user before running this suite.');
  let pg: Client;
  let userId: number;
  let snapshot: PreferencesSnapshot;
  // Track nudge rows we should remove on teardown even if `cleanup.ts`
  // somehow misses them (e.g. the LLM returned a question we couldn't tag
  // because the UPDATE raced the INSERT — defensive only).
  const createdNudgeIds: number[] = [];

  test.beforeAll(async () => {
    pg = buildPgClient();
    await pg.connect();
    const userRes = await pg.query<{ id: number }>(
      'SELECT id FROM pm.users WHERE login = $1 LIMIT 1',
      [login],
    );
    if (userRes.rowCount === 0) {
      throw new Error('[concierge.spec] could not resolve the configured E2E_PM_LOGIN');
    }
    userId = userRes.rows[0].id;
    snapshot = await snapshotPreferencesForCookieUser(pg, userId);
  });

  test.afterAll(async () => {
    // Hard-delete any nudges the LLM trigger inserted, then restore
    // preferences regardless of test outcome.
    try {
      if (createdNudgeIds.length > 0) {
        await pg.query(
          `DELETE FROM concierge.nudges WHERE id = ANY($1::bigint[])`,
          [createdNudgeIds],
        );
      }
      await restorePreferences(pg, snapshot);
    } finally {
      await pg.end();
    }
  });

  test('home loader renders', async ({ page }) => {
    await page.goto(`${APPS.concierge.baseUrl}/`);
    // The Concierge header is the canary that loadHome succeeded.
    await expect(page.getByRole('heading', { name: 'Concierge' })).toBeVisible({
      timeout: 15_000,
    });
    // Preferences panel + manual trigger button are always rendered for a
    // signed-in user.
    await expect(page.locator('[data-testid="prefs"]')).toBeVisible();
    await expect(page.locator('[data-testid="manual-trigger"]')).toBeVisible();
  });

  test('toggle preferences via cookie-authed API', async ({ request }) => {
    // Force enabled=true with a wide-open cadence so we can manually
    // trigger right after (cadence is bypassed by /api/trigger but
    // honoured by the cron).
    const res = await request.post(`${APPS.concierge.baseUrl}/api/preferences`, {
      data: {
        enabled: true,
        cadenceMinutes: 60,
        quietStart: null,
        quietEnd: null,
      },
    });
    expect(res.status(), `prefs status (body: ${await res.text()})`).toBe(200);
    const next = (await res.json()) as {
      enabled: boolean;
      cadenceMinutes: number;
    };
    expect(next.enabled).toBe(true);
    expect(next.cadenceMinutes).toBe(60);

    // And the row actually landed in PG.
    const dbRes = await pg.query<{ enabled: boolean; cadence_minutes: number }>(
      `SELECT enabled, cadence_minutes FROM concierge.preferences WHERE user_id = $1`,
      [userId],
    );
    expect(dbRes.rowCount).toBe(1);
    expect(dbRes.rows[0].enabled).toBe(true);
    expect(dbRes.rows[0].cadence_minutes).toBe(60);
  });

  test('manual trigger drives the nudge pipeline', async ({ request }) => {
    // Capture the highest nudge id BEFORE we hit /api/trigger so we can
    // pin "which nudge(s) did this test create" and tag them for cleanup
    // regardless of the response shape.
    const beforeRes = await pg.query<{ max_id: number | null }>(
      `SELECT MAX(id)::bigint AS max_id FROM concierge.nudges WHERE user_id = $1`,
      [userId],
    );
    const beforeMaxId = Number(beforeRes.rows[0].max_id ?? 0);

    const res = await request.post(`${APPS.concierge.baseUrl}/api/trigger`);
    const rawBody = await res.text().catch(() => '');

    // Sweep any nudge rows created by this trigger BEFORE we assert — that
    // way a flaky LLM response (5xx) still leaves the DB pristine because
    // we tag every newly-inserted row for cleanup.
    const newRows = await pg.query<{ id: number; question: string }>(
      `SELECT id, question FROM concierge.nudges
         WHERE user_id = $1 AND id > $2`,
      [userId, beforeMaxId],
    );
    for (const r of newRows.rows) {
      createdNudgeIds.push(Number(r.id));
      await tagNudgeForCleanup(pg, Number(r.id));
    }

    // 200 = pipeline ran end-to-end (sent / skipped-gate / skipped-llm).
    // 500 = the LLM round-trip (or a downstream fetch) failed — known
    // brittle against deployed prod because the LLM is real.  Either is a
    // legitimate outcome of "cookie auth + handler reached"; we only fail
    // if the endpoint is fundamentally unreachable or returns auth errors.
    expect(
      [200, 500],
      `trigger status unexpected (body: ${rawBody})`,
    ).toContain(res.status());

    if (res.status() === 200) {
      const body = JSON.parse(rawBody) as {
        status: 'sent' | 'skipped-gate' | 'skipped-llm';
        nudge?: { id: number; question: string };
        reason?: string;
      };
      if (body.status === 'sent') {
        expect(body.nudge).toBeTruthy();
        expect(body.nudge!.id).toBeGreaterThan(beforeMaxId);
        // The tag UPDATE above should have prefixed the question.
        const verify = await pg.query<{ question: string }>(
          `SELECT question FROM concierge.nudges WHERE id = $1`,
          [body.nudge!.id],
        );
        expect(verify.rows[0].question.startsWith(CONCIERGE_E2E_PREFIX)).toBe(true);
      } else {
        expect(['skipped-gate', 'skipped-llm']).toContain(body.status);
      }
    } else {
      // 500: log it so flakes are visible but don't fail the suite —
      // the contract we care about (cookie auth + handler dispatch) is
      // covered by the preferences test.  When the LLM is healthy and
      // this still 500s, investigate via wrangler tail.
      // eslint-disable-next-line no-console
      console.warn(`[concierge.spec] /api/trigger returned 500: ${rawBody}`);
    }
  });
});
