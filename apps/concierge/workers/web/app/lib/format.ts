// Tiny formatting helpers for the concierge UI.

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

// Human label for the `topic` enum.  Stored as a short slug in the DB; the
// admin UI renders the friendly form.
const TOPIC_LABELS: Record<string, string> = {
  'inbox-idle': 'Inbox idle',
  'focus-abandoned': 'Focus abandoned',
  'pm-stalled': 'PM stalled',
  'celebration': 'Celebration',
  'open-thread': 'Open thread',
  'event': 'Cross-app event',
};

export function topicLabel(slug: string): string {
  return TOPIC_LABELS[slug] ?? slug;
}

/** "in 2h 30m" / "in 45m" / "now".  Used to show the next-eligible window. */
export function inFuture(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (rem === 0) return `in ${hours}h`;
  return `in ${hours}h ${rem}m`;
}

/**
 * Minutes-from-midnight (0..1439) → "HH:MM".  Used by the admin UI's
 * quiet-hours editor.  null / out-of-range returns empty so the input
 * placeholder shows through.
 */
export function minutesToHHMM(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m) || m < 0 || m >= 1440) return '';
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Inverse of minutesToHHMM.  "22:30" -> 1350.  Returns null on parse error. */
export function hhmmToMinutes(s: string): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number) as [number, number];
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
