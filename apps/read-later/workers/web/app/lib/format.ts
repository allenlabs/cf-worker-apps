// Tiny formatting helpers for the read-later UI.
//
// Queue surface needs:
//   - timeAgo("3h ago")
//   - readingTimeLabel(estimatedMinutes)
//   - hostnameOf(url) for the compact source label
//   - skipCountLabel for the "skipped 3 times" badge

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function timeAgo(input: Date | string | number, now: number = Date.now()): string {
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  if (diff < 60 * 1000) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * "1 min read" / "5 min read" / "" if no estimate.  Capped at 60 min — past
 * that the precise minute count stops mattering and we want "60+ min read"
 * to read as a soft warning.
 */
export function readingTimeLabel(estimatedMinutes: number | null | undefined): string {
  if (estimatedMinutes == null || !Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
    return '';
  }
  if (estimatedMinutes >= 60) return '60+ min read';
  if (estimatedMinutes === 1) return '1 min read';
  return `${estimatedMinutes} min read`;
}

/**
 * Extract the bare hostname from a URL string for compact UI labels.
 * Returns "" on parse failure so the caller can branch cleanly.
 */
export function hostnameOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * "skipped 3 times" / "" for 0.  The point is to make skip-spirals visible
 * to the user — if a thing keeps getting skipped, maybe it shouldn't be in
 * the queue at all.
 */
export function skipCountLabel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  if (n === 1) return 'skipped 1 time';
  return `skipped ${n} times`;
}

/**
 * Word count for plain-text content.  Whitespace-split, empty tokens
 * filtered.  Used at save time to compute `estimated_minutes`.
 */
export function wordCount(text: string): number {
  if (!text) return 0;
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

/**
 * estimated_minutes = max(1, round(words / 220)).  220 wpm is the median
 * adult reading rate; rounding down to 0 would be misleading on a 10-word
 * captured tweet so we floor at 1.
 */
export function estimateMinutes(words: number): number {
  if (!Number.isFinite(words) || words <= 0) return 1;
  return Math.max(1, Math.round(words / 220));
}
