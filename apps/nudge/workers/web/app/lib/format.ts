// Tiny formatting helpers for the nudge UI.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60 * 1000;

export function timeAgo(input: Date | string | number, now: number = Date.now()): string {
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Future-oriented relative label, e.g. "in 5 min" / "in 2 hours". */
export function timeUntil(input: Date | string | number, now: number = Date.now()): string {
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  if (diff <= 0) return 'now';
  if (diff < MINUTE) return 'in <1 min';
  if (diff < HOUR) return `in ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `in ${Math.floor(diff / HOUR)} h`;
  const days = Math.floor(diff / DAY);
  if (days < 30) return `in ${days} d`;
  return new Date(t).toISOString().slice(0, 10);
}
