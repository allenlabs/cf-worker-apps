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
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const IMPORTANCE_LABEL = ['', 'small', 'medium', 'big'];

export function importanceLabel(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1 || n > 3) return '';
  return IMPORTANCE_LABEL[n]!;
}

const KIND_LABEL: Record<string, string> = {
  pr_merged: 'PR merged',
  issue_closed: 'Issue closed',
  focus_completed: 'Focus session',
  inbox_zeroed: 'Inbox zero',
  custom: 'Custom',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}
