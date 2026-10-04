// Tiny formatting helpers for the context UI.
//
// The home list shows "fixing auth bug · 12m ago · restored 2x"; the restore
// view labels recognised payload keys with a friendly header.  All formatting
// is local-time + pure so tests can pin "now".

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
 * Human label for a payload key.  Recognised keys (cwd, branch, files,
 * tabs, processes, terminals) get curated headings; everything else falls
 * back to a title-cased version of the key so a CLI that captures
 * `git_status` gets "Git Status" instead of "git_status".
 */
export const RECOGNISED_KEYS = [
  'cwd',
  'branch',
  'files',
  'tabs',
  'processes',
  'terminals',
] as const;
export type RecognisedKey = (typeof RECOGNISED_KEYS)[number];

const KEY_LABELS: Record<RecognisedKey, string> = {
  cwd: 'Working directory',
  branch: 'Git branch',
  files: 'Recent files',
  tabs: 'Browser tabs',
  processes: 'Processes',
  terminals: 'Terminals',
};

export function isRecognisedKey(k: string): k is RecognisedKey {
  return (RECOGNISED_KEYS as readonly string[]).includes(k);
}

export function payloadKeyLabel(k: string): string {
  if (isRecognisedKey(k)) return KEY_LABELS[k];
  // Generic fall-back: "git_status" → "Git Status", "openTabs" → "Open Tabs".
  const spaced = k
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return k;
  return spaced
    .split(/\s+/)
    .map(titleCaseWord)
    .join(' ');
}

/* v8 ignore start — `split(/\s+/)` on a trimmed non-empty string can't
   yield a 0-length token; the guard exists so noUncheckedIndexedAccess
   + `w[0]!` is sound. */
function titleCaseWord(w: string): string {
  if (w.length === 0) return w;
  return w[0]!.toUpperCase() + w.slice(1);
}
/* v8 ignore stop */

/**
 * Render a payload value as a single-line preview for the table view.  The
 * full value is exposed via the JSON detail; this is just for visual scanning.
 */
export function previewValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty)';
    const head = v.slice(0, 3).map((x) => previewValue(x)).join(', ');
    return v.length > 3 ? `${head}, … (+${v.length - 3} more)` : head;
  }
  try {
    return JSON.stringify(v);
  } catch {
    /* v8 ignore next 2 — JSON.stringify only throws on circular refs; the
       CLI never sends those (payload is always a fresh object). */
    return String(v);
  }
}

/**
 * "1 restore" / "5 restores" / "never restored".  Used on the home list.
 * The killer pivot from "streak counter" is that *not* restoring is a
 * neutral observation, never a punishment.
 */
export function restoreCountLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'never restored';
  if (n === 1) return '1 restore';
  return `${n} restores`;
}
