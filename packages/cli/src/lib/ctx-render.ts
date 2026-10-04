// Rendering helpers for `al ctx restore` and `al ctx list`.
//
// Kept separate from the command (which is the network-glue layer) so
// the formatting is unit-testable without mocking signedFetch.

import { formatRelativeAge } from './humans.js';

export interface SnapshotPayload {
  cwd?: unknown;
  branch?: unknown;
  tmux?: unknown;
  files?: unknown;
  git_status?: unknown;
  processes?: unknown;
  [k: string]: unknown;
}

export interface SnapshotDetail {
  id: number;
  name: string;
  notes: string | null;
  payload: SnapshotPayload;
  createdAt: string;
  restoredAt: string | null;
  restoredCount: number;
}

export interface SnapshotSummary {
  id: number;
  name: string;
  createdAt: string;
  restoredAt: string | null;
  restoredCount: number;
}

/**
 * Coerce a string-or-string-array payload field into a single string.
 * Falls back to null for unrecognised shapes so the caller can skip
 * the line entirely.
 */
export function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

/** Split a multi-line capture (tmux/files/git_status) into an array. */
export function asLines(v: unknown): string[] | null {
  const s = asString(v);
  if (s === null) return null;
  const out = s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return out.length > 0 ? out : null;
}

/** Header line: "↩ ctx #42 'fixing auth bug' (saved Xh ago, last restored Yh ago, 3 restores)". */
export function formatHeader(
  detail: SnapshotDetail,
  now: number = Date.now(),
): string {
  const created = Date.parse(detail.createdAt);
  const savedAgo = formatRelativeAge(created, now);
  let trailing: string;
  if (detail.restoredCount === 0 || detail.restoredAt === null) {
    trailing = `${savedAgo}, never restored`;
  } else {
    const restoredAgo = formatRelativeAge(Date.parse(detail.restoredAt), now);
    const noun = detail.restoredCount === 1 ? 'restore' : 'restores';
    trailing = `saved ${savedAgo}, last restored ${restoredAgo}, ${detail.restoredCount} ${noun}`;
  }
  return `↩ ctx #${detail.id} '${detail.name}'  (${trailing})`;
}

export interface RenderRestoreOptions {
  clipboardTool: string | null; // null = printed only
  now?: number;
}

/**
 * Render the full restore block as a list of lines.  Lines are produced
 * only for payload keys that are present + decodable; missing or
 * malformed keys are silently dropped.
 */
export function renderRestore(
  detail: SnapshotDetail,
  opts: RenderRestoreOptions,
): string[] {
  const out: string[] = [];
  out.push(formatHeader(detail, opts.now));

  const cwd = asString(detail.payload.cwd);
  if (cwd) {
    const suffix = opts.clipboardTool
      ? `(cd command copied via ${opts.clipboardTool})`
      : `(run: cd ${cwd})`;
    out.push(`📁 ${cwd}    ${suffix}`);
  }

  const branch = asString(detail.payload.branch);
  if (branch) {
    out.push(`🌿 ${branch}                                            (run: git switch ${branch})`);
  }

  const tmux = asLines(detail.payload.tmux);
  if (tmux) {
    out.push(`📦 tmux windows: ${tmux.join(', ')}`);
  }

  const files = asLines(detail.payload.files);
  if (files) {
    out.push(`📝 Recent files: ${files.slice(0, 10).join(', ')}`);
  }

  const git = asLines(detail.payload.git_status);
  if (git) {
    out.push(`🌀 git status (${git.length} ${git.length === 1 ? 'change' : 'changes'}):`);
    for (const row of git.slice(0, 10)) {
      out.push(`     ${row}`);
    }
  }

  if (detail.notes) {
    out.push(`📝 note: ${detail.notes}`);
  }

  return out;
}

/** One-line list-row formatter for `al ctx list`. */
export function formatListRow(s: SnapshotSummary, now: number = Date.now()): string {
  const ago = formatRelativeAge(Date.parse(s.createdAt), now);
  if (s.restoredCount === 0) {
    return `#${s.id}  ${s.name}  ${ago}  (never restored)`;
  }
  const noun = s.restoredCount === 1 ? 'restore' : 'restores';
  return `#${s.id}  ${s.name}  ${ago}  (${s.restoredCount} ${noun})`;
}

/** Shell-shorthand for the cwd: a `cd` command suitable for pasting. */
export function cdCommand(cwd: string): string {
  // Quote with single-quotes (escape any embedded singles); shells then
  // treat the entire path literally regardless of spaces or $vars.
  return `cd '${cwd.replace(/'/g, `'\\''`)}'`;
}
