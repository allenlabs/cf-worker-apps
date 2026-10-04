// Pure cron logic split out of `index.ts` so unit tests (running in the
// plain-node Vitest project) can import it without pulling in the worker
// entrypoint — which imports `@microlabs/otel-cf-workers`, which in turn
// imports from the `cloudflare:` virtual scheme that Node can't resolve.

import type { DB } from '../web/app/db/client';
import {
  listEnabledUserIdsImpl,
} from '../web/app/server/concierge';
import {
  processNudgeForUserImpl,
  type ProcessNudgeEnv,
  type ProcessResultStatus,
} from '../web/app/server/pipeline';

export interface CronEnv extends ProcessNudgeEnv {
  HYPERDRIVE: Hyperdrive;
  CRON_MAX_USERS?: string;
}

export interface CronResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
  durationMs: number;
  /** Per-user breakdown surfaced in logs for the user to verify "did anything
   *  happen this tick?" without hitting the DB. */
  details: Array<{ userId: number; status: ProcessResultStatus | 'error'; reason?: string }>;
}

/** Dependency-injected variant.  The wrapper in `index.ts` passes the real
 *  Hyperdrive-backed DB; tests pass a PGlite-backed one. */
export async function runCron(
  env: CronEnv,
  dbFactory: (env: CronEnv) => DB,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<CronResult> {
  const started = Date.now();
  const db = dbFactory(env);
  const maxUsers = Number(env.CRON_MAX_USERS ?? '100');
  const userIds = await listEnabledUserIdsImpl(db, maxUsers);

  const details: CronResult['details'] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;
  for (const userId of userIds) {
    try {
      const result = await processNudgeForUserImpl(env, db, userId, {
        now,
        fetchFn,
        channels: ['push', 'today'],
      });
      if (result.status === 'sent') {
        sent++;
        details.push({ userId, status: 'sent' });
      } else {
        skipped++;
        details.push({
          userId,
          status: result.status,
          reason: result.reason,
        });
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[concierge-cron] user_id=${userId} error:`, msg.slice(0, 300));
      details.push({ userId, status: 'error', reason: msg.slice(0, 200) });
    }
  }

  return {
    scanned: userIds.length,
    sent,
    skipped,
    errors,
    durationMs: Date.now() - started,
    details,
  };
}
