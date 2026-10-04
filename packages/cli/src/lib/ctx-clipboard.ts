// Clipboard auto-detect for `al ctx restore`.
//
// We try (in order) `pbcopy` (macOS), `wl-copy` (Wayland), `xclip`
// (X11).  The first one that writes successfully wins.  If nothing
// works we return false and the caller prints `(run: cd <path>)`
// instead.
//
// Like ctx-capture, the spawn is wrapped behind an injectable runner
// so tests don't actually touch /usr/bin/{pbcopy,wl-copy,xclip}.

import { spawn } from 'node:child_process';

export interface ClipboardRunResult {
  code: number;
}

export type ClipboardRunner = (
  command: string,
  args: readonly string[],
  payload: string,
) => Promise<ClipboardRunResult>;

export const defaultClipboardRunner: ClipboardRunner = (command, args, payload) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve({ code: 127 }));
    /* v8 ignore next — `code` is null only on signal kill; the fallback
       is defensive and not exercisable deterministically. */
    child.on('close', (code) => resolve({ code: code ?? 0 }));
    child.stdin.end(payload);
  });

export interface ClipboardCandidate {
  command: string;
  args: readonly string[];
}

/** The default candidate list, tried in order until one succeeds. */
export const DEFAULT_CANDIDATES: readonly ClipboardCandidate[] = [
  { command: 'pbcopy', args: [] },
  { command: 'wl-copy', args: [] },
  { command: 'xclip', args: ['-selection', 'clipboard'] },
];

/**
 * Try each candidate in turn.  Returns the name of the tool that
 * succeeded, or null if none worked.
 */
export async function copyToClipboard(
  payload: string,
  opts: {
    runner?: ClipboardRunner;
    candidates?: readonly ClipboardCandidate[];
  } = {},
): Promise<string | null> {
  const runner = opts.runner ?? defaultClipboardRunner;
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;
  for (const c of candidates) {
    const r = await runner(c.command, c.args, payload);
    if (r.code === 0) return c.command;
  }
  return null;
}
