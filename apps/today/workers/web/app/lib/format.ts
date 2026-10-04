// Tiny formatting helpers for the today dashboard.
//
// ADHD-aware design choice (matches focus' rationale): wherever we show a
// duration we also show the clock-time it ends at when applicable, so an
// active focus session reads "ends at 14:47" rather than just "25:00 to go".

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
 * "ends at 14:47" label under the hero card when there's an active focus
 * session.
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
 * "25 min" / "1 h 5 min" — used in the Focus-today panel so a day with
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
 * Truncate text to `max` chars; appends an ellipsis if cut.  Used for the
 * hero label so a 600-char inbox capture doesn't blow the layout.
 */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Compare two Date instances at local-day granularity.  Used by
 * `pickOneNextAction` to find a PM issue with `due_date === today`.
 */
export function sameLocalDay(a: Date, b: Date): boolean {
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
