// Tiny formatting helpers for the solved UI.

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

export function bodyPreview(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

export function highlightSegments(input: string): Array<{ text: string; mark: boolean }> {
  if (!input) return [];
  const segments: Array<{ text: string; mark: boolean }> = [];
  const parts = input.split(/<b>|<\/b>/);
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!;
    if (text === '') continue;
    segments.push({ text, mark: i % 2 === 1 });
  }
  return segments;
}
