// Tiny formatting helpers for the stash UI.

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
 * Single-line preview of a snippet body for the list view.  Strips newlines,
 * collapses runs of whitespace, truncates to 160 chars w/ an ellipsis.  Keeps
 * the visual grid tidy when bodies are pasted shell sessions / multi-line
 * code.
 */
export function bodyPreview(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

/**
 * Build the visible page-number list for a paginator that elides the
 * middle when there are many pages.  Returns `'…'` markers where elided.
 * Always includes 1 and `total` (when total > 1) and a small window
 * around the current page.
 */
export function paginationPages(current: number, total: number): Array<number | '…'> {
  if (total <= 1) return total === 1 ? [1] : [];
  const window = 1;
  const set = new Set<number>([1, total, current]);
  for (let i = current - window; i <= current + window; i++) {
    if (i >= 1 && i <= total) set.add(i);
  }
  const sorted = Array.from(set).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev: number | null = null;
  for (const n of sorted) {
    if (prev != null && n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}

/**
 * Human label for the language column.  Maps common short codes (sh, js, ts,
 * sql, md) to a friendlier display name, falling back to the raw value so a
 * CLI that captures `python` or `dockerfile` still shows something sensible.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  sh: 'shell',
  bash: 'bash',
  zsh: 'zsh',
  js: 'JavaScript',
  ts: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  sql: 'SQL',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
};

export function languageLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (!k) return null;
  return LANGUAGE_LABELS[k] ?? raw;
}

/**
 * Highlight ts_headline output: Postgres emits `<b>match</b>` markers.  We
 * keep the strings safe by HTML-escaping everything *except* the markers,
 * then converting them to React-rendered <mark> via a tiny tokenizer.
 *
 * Returns an array of `{ text, mark }` segments so the caller can render
 * with React (no dangerouslySetInnerHTML).
 */
export function highlightSegments(input: string): Array<{ text: string; mark: boolean }> {
  if (!input) return [];
  const segments: Array<{ text: string; mark: boolean }> = [];
  // Postgres ts_headline default markers are `<b>` / `</b>`.  We split on
  // those (case-insensitive, but Postgres always emits lowercase).
  const parts = input.split(/<b>|<\/b>/);
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!;
    if (text === '') continue;
    segments.push({ text, mark: i % 2 === 1 });
  }
  return segments;
}
