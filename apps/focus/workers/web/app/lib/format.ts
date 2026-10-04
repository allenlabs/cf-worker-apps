// Tiny formatting helpers for the focus UI.
//
// ADHD-aware design choice: alongside a count-up / count-down number we
// always show the *clock time* the session will end.  ADHD brains often
// struggle to translate "25 minutes" into clock-time meaning (time
// blindness), so "ends at 14:47" is more actionable than "25:00 to go".

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
 * "HH:MM" in the user's local time zone (24-hour).  Used for the
 * "ends at 14:47" label on the active session screen and in the heatmap
 * day drill-down.
 */
export function clockTime(input: Date | string | number): string {
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * "M:SS" countdown like 24:59.  Negative values clamp to 0:00.  We pass
 * `secondsRemaining` as a number so the SVG-animated timer stays drift-free
 * (the CSS animation drives the visual sweep; the label is recomputed from
 * `endsAt - now` on each render tick).
 */
export function mmss(secondsRemaining: number): string {
  const s = Math.max(0, Math.floor(secondsRemaining));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * "25 min" / "1 h 5 min" — used in the heatmap day drill-down so a day with
 * three 25-minute sessions reads "1 h 15 min" rather than "75 min".
 */
export function humanMinutes(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  if (m === 0) return '0 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (r === 0) return `${h} h`;
  return `${h} h ${r} min`;
}

/**
 * Used by the heatmap: "5 days ago" / "today" / "yesterday".  Distinct from
 * timeAgo() because the heatmap shows day-granularity, not minute.
 */
export function dayLabel(date: Date | string, now: Date = new Date()): string {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  // Anchor both at midnight (local time) so DST changes don't trip us.
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((b - a) / DAY);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays > 0) return `${diffDays} days ago`;
  return d.toISOString().slice(0, 10);
}
