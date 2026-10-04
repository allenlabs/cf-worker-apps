export function relativeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'just now';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'just now';
  const delta = Math.max(0, now.getTime() - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

const TARGETS = ['context', 'inbox', 'journal'] as const;
export type Target = typeof TARGETS[number];

export function isTarget(v: unknown): v is Target {
  return typeof v === 'string' && (TARGETS as readonly string[]).includes(v);
}

export function targetLabel(t: string | null | undefined): string {
  if (!t) return 'kept here only';
  if (isTarget(t)) return `→ ${t}`;
  return t;
}
