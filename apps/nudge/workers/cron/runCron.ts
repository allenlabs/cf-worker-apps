// Pure cron logic split out so unit tests (running in the plain-node Vitest
// project) can import it without pulling in @microlabs/otel-cf-workers
// (which imports from the `cloudflare:` virtual scheme).

import type { DB } from '../web/app/db/client';
import { listDueImpl, markDeliveredImpl } from '../web/app/server/nudge';
import { signRequest } from '../web/app/lib/hmac';

export interface CronEnv {
  HYPERDRIVE: Hyperdrive;
  INBOX_API_URL?: string;
  INBOX_HMAC_CLIENT_ID?: string;
  INBOX_HMAC_SECRET?: string;
  CRON_MAX_REMINDERS?: string;
  PUBLIC_WEB_URL?: string;
}

export interface CronResult {
  scanned: number;
  delivered: number;
  skipped: number;
  errors: number;
  durationMs: number;
  details: Array<{ id: number; userId: number; status: 'delivered' | 'skipped' | 'error'; reason?: string }>;
}

export async function runCron(
  env: CronEnv,
  dbFactory: (env: CronEnv) => DB,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<CronResult> {
  const started = Date.now();
  const db = dbFactory(env);
  const maxReminders = Number(env.CRON_MAX_REMINDERS ?? '500');

  const due = await listDueImpl(db, now, maxReminders);

  const details: CronResult['details'] = [];
  let delivered = 0;
  let skipped = 0;
  let errors = 0;
  const inboxConfigured = Boolean(
    env.INBOX_API_URL && env.INBOX_HMAC_CLIENT_ID && env.INBOX_HMAC_SECRET,
  );

  for (const row of due) {
    try {
      if (inboxConfigured) {
        const body = JSON.stringify({
          userId: row.userId,
          title: 'Nudge',
          body: row.text,
          url: env.PUBLIC_WEB_URL ?? 'https://nudge.allenlabs.org/',
          tag: `nudge-${row.id}`,
        });
        const ts = Date.now();
        const sig = await signRequest(env.INBOX_HMAC_SECRET!, body, ts);
        const url = `${env.INBOX_API_URL!.replace(/\/$/, '')}/v1/notify`;
        const res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Client-Id': env.INBOX_HMAC_CLIENT_ID!,
            'X-Timestamp': String(ts),
            'X-Signature': sig,
          },
          body,
        });
        if (!res.ok) {
          errors++;
          details.push({ id: row.id, userId: row.userId, status: 'error', reason: `inbox ${res.status}` });
          continue;
        }
      } else {
        skipped++;
        details.push({ id: row.id, userId: row.userId, status: 'skipped', reason: 'inbox not configured' });
      }
      await markDeliveredImpl(db, row.id, now);
      if (inboxConfigured) {
        delivered++;
        details.push({ id: row.id, userId: row.userId, status: 'delivered' });
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[nudge-cron] reminder id=${row.id} error:`, msg.slice(0, 300));
      details.push({ id: row.id, userId: row.userId, status: 'error', reason: msg.slice(0, 200) });
    }
  }

  return {
    scanned: due.length,
    delivered,
    skipped,
    errors,
    durationMs: Date.now() - started,
    details,
  };
}
