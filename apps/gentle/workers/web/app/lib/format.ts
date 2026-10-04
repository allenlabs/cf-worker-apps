// Tiny formatting helpers for the gentle UI.

/** ISO yyyy-mm-dd in UTC. */
export function todayUtcIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Inclusive [from, to] date pair covering the last N days (UTC). */
export function lastNDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const safeDays = Math.max(1, Math.floor(days));
  const to = todayUtcIso(now);
  const fromDate = new Date(now.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
  const from = todayUtcIso(fromDate);
  return { from, to };
}

/**
 * Heatmap intensity bucket — gentle has 5 toggle fields, so the score is
 * 0..5 booleans-true.  Returns 0..5 buckets (0 = missed day; 1..5 = how
 * many toggles flipped).  Missed days FADE (bucket 0) but don't reset
 * anything.
 */
export function intensityBucket(score: number | null | undefined): number {
  if (score == null) return 0;
  const n = Math.max(0, Math.min(5, Math.floor(score)));
  return n;
}

/** Iterate every yyyy-mm-dd date in [from, to] inclusive (UTC). */
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
