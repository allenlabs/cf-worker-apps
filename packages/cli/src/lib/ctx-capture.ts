// Context-capture helpers.
//
// `al ctx save <name>` shells out to a handful of tools (git, ls, tmux,
// ps) to snapshot the developer's working context.  Each capture source
// is best-effort: if the tool is missing, errors out, or the relevant
// state isn't present (no git repo, no $TMUX), the source is *skipped*
// and we move on — saving a partial snapshot is fine, refusing to save
// because tmux isn't running is not.
//
// The shell-out itself is wrapped behind a `CaptureRunner` interface so
// the unit tests can stub it without touching child_process.

import { spawn } from 'node:child_process';

export interface CaptureRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Minimal interface over child_process.spawn that tests can stub. */
export type CaptureRunner = (
  command: string,
  args: readonly string[],
) => Promise<CaptureRunResult>;

/** Default runner: spawn, collect stdout/stderr, never throw. */
export const defaultRunner: CaptureRunner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', () => { resolve({ code: 127, stdout: '', stderr: 'spawn failed' }); });
    /* v8 ignore next — `code` is null only when the child is killed by a
       signal; we can't synthesise that deterministically in CI, and the
       fallback is purely defensive. */
    child.on('close', (code) => { resolve({ code: code ?? 0, stdout, stderr }); });
  });

export interface CaptureEnv {
  /** `process.cwd()` — only stubbed in tests. */
  cwd: () => string;
  /** Parsed `process.env`.  We only read `TMUX`. */
  env: NodeJS.ProcessEnv;
}

export const defaultEnv: CaptureEnv = {
  cwd: () => process.cwd(),
  env: process.env,
};

/** Split a multi-line stdout into individual rows, dropping empties. */
export function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);
}

/** Truncate a list of strings to `max` rows (returned as joined lines). */
export function truncateLines(s: string, max: number): string {
  return lines(s).slice(0, max).join('\n');
}

export interface CaptureOptions {
  runner?: CaptureRunner;
  env?: CaptureEnv;
}

export interface CapturedContext {
  cwd?: string;
  branch?: string;
  git_status?: string;
  files?: string;
  tmux?: string;
  processes?: string;
}

export interface CaptureOutcome {
  context: CapturedContext;
  /** Names of capture sources that actually contributed data. */
  sources: string[];
}

/**
 * Capture all sources.  Each source is independent; a failure in one
 * (no git repo, no $TMUX, missing binary) doesn't block the others.
 *
 * Order in `sources` matches the order shown in the success line:
 * cwd, branch, git_status, tmux, files, processes.
 */
export async function captureContext(opts: CaptureOptions = {}): Promise<CaptureOutcome> {
  const runner = opts.runner ?? defaultRunner;
  const env = opts.env ?? defaultEnv;
  const context: CapturedContext = {};
  const sources: string[] = [];

  // cwd — always available.
  const cwd = env.cwd();
  if (cwd && cwd.length > 0) {
    context.cwd = cwd;
    sources.push('cwd');
  }

  // branch — only inside a git repo.
  const branchRun = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRun.code === 0) {
    const branch = branchRun.stdout.trim();
    if (branch.length > 0) {
      context.branch = branch;
      sources.push('branch');
    }
  }

  // git status — porcelain, first 30 lines.
  const statusRun = await runner('git', ['status', '--porcelain']);
  if (statusRun.code === 0) {
    const trimmed = truncateLines(statusRun.stdout, 30);
    if (trimmed.length > 0) {
      context.git_status = trimmed;
      sources.push('git_status');
    }
  }

  // tmux windows — only if $TMUX is set.
  if (env.env.TMUX && env.env.TMUX.length > 0) {
    const tmuxRun = await runner('tmux', ['list-windows', '-F', '#W']);
    if (tmuxRun.code === 0) {
      const out = tmuxRun.stdout.trim();
      if (out.length > 0) {
        context.tmux = out;
        sources.push('tmux');
      }
    }
  }

  // files — MRU via `ls -t`, top 10.  Run inside cwd.
  const filesRun = await runner('ls', ['-t', cwd]);
  if (filesRun.code === 0) {
    const trimmed = truncateLines(filesRun.stdout, 10);
    if (trimmed.length > 0) {
      context.files = trimmed;
      sources.push('files');
    }
  }

  // processes — top 5 by CPU usage.
  const psRun = await runner('ps', ['-eo', 'pid,comm', '--sort=-pcpu']);
  if (psRun.code === 0) {
    const trimmed = truncateLines(psRun.stdout, 5);
    if (trimmed.length > 0) {
      context.processes = trimmed;
      sources.push('processes');
    }
  }

  return { context, sources };
}
