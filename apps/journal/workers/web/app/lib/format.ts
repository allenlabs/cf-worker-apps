// Tiny formatting helpers for the journal UI.

/** ISO yyyy-mm-dd in UTC.  Journal entries are date-typed (no time component);
 *  we always compute the user's "today" in UTC because the server is the
 *  source of truth and we don't yet store per-user time zones. */
export function todayUtcIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Map a 1-5 mood score to a tiny set of human labels.  null/undefined → '?'.  */
export function moodLabel(v: number | null | undefined): string {
  if (v == null) return '?';
  switch (v) {
    case 1: return 'rough';
    case 2: return 'low';
    case 3: return 'meh';
    case 4: return 'good';
    case 5: return 'great';
    default: return '?';
  }
}

/** Heatmap colour intensity for a daily aggregate (mood+energy+focus).  Returns
 *  0..4 buckets so the UI can pick from 5 colour swatches. */
export function intensityBucket(score: number | null | undefined): number {
  if (score == null) return 0;
  if (score < 6) return 1;
  if (score < 9) return 2;
  if (score < 12) return 3;
  return 4;
}

/** Compute an inclusive [from, to] date pair (UTC) covering the last N days. */
export function lastNDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const safeDays = Math.max(1, Math.floor(days));
  const to = todayUtcIso(now);
  const fromDate = new Date(now.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
  const from = todayUtcIso(fromDate);
  return { from, to };
}

/** Inclusive ISO yyyy-mm-dd date iterator (UTC). */
export function eachDate(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
