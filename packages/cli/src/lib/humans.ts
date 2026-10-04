// Human-friendly formatters.  Pre-computed clock times beat "in 25 min"
// every time for ADHD time-blindness — show the wall-clock target.

/** Pad a positive integer with a leading zero if < 10. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a Date (or epoch ms) as local HH:MM. */
export function formatClock(t: Date | number): string {
  const d = t instanceof Date ? t : new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "25 min", "1 min", "2 hr 5 min", "now" (when <= 0). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (min === 0) return `${hr} hr`;
  return `${hr} hr ${min} min`;
}

/**
 * The marquee start-of-session line: full intent.
 *   "(25 min — ends at 14:47)"
 */
export function formatSessionWindow(targetMinutes: number, endsAt: Date | number): string {
  return `(${formatDuration(targetMinutes * 60_000)} — ends at ${formatClock(endsAt)})`;
}

/**
 * Shell-prompt one-liner: minimal noise.
 *   "focus 14m left"        normal
 *   "focus over by 3m"      ran past target
 *   ""                      no session active (intentionally empty so PS1 stays clean)
 */
export function formatPromptSnippet(
  startedAt: Date | number,
  targetMinutes: number,
  now: Date | number = Date.now(),
): string {
  const start = startedAt instanceof Date ? startedAt.getTime() : startedAt;
  const n = now instanceof Date ? now.getTime() : now;
  const endsAt = start + targetMinutes * 60_000;
  const remainingMs = endsAt - n;
  if (remainingMs >= 0) {
    const min = Math.ceil(remainingMs / 60_000);
    return `focus ${min}m left`;
  }
  const overMin = Math.ceil((-remainingMs) / 60_000);
  return `focus over by ${overMin}m`;
}

/**
 * "captured 2 min ago", "captured at 14:23".  Used for `al inbox list`.
 * Falls back to a date string if older than 24 hours.
 */
export function formatRelativeAge(captured: Date | number, now: Date | number = Date.now()): string {
  const c = captured instanceof Date ? captured.getTime() : captured;
  const n = now instanceof Date ? now.getTime() : now;
  const diff = n - c;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) {
    const m = Math.floor(diff / 60_000);
    return `${m}m ago`;
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.floor(diff / (60 * 60_000));
    return `${h}h ago`;
  }
  const d = Math.floor(diff / (24 * 60 * 60_000));
  return `${d}d ago`;
}

/** Truncate a single-line preview, ellipsizing past `max` chars. */
export function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
