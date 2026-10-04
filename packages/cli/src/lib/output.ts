// Output modes.  Three flavors:
//   default  — one line, no banner.  E.g. "✓ #42".
//   verbose  — adds context.  Diagnostics go to stderr.
//   json     — machine-readable on stdout.  Errors still to stderr.

export type OutputMode = 'default' | 'verbose' | 'json';

export interface IO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Build an IO wrapper around process.stdout / stderr (or stubs in tests). */
export function makeIO(
  stdout: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
  stderr: (s: string) => void = (s) => process.stderr.write(`${s}\n`),
): IO {
  return { stdout, stderr };
}

export interface ModeFlags {
  verbose?: boolean;
  json?: boolean;
}

export function resolveMode(flags: ModeFlags): OutputMode {
  if (flags.json) return 'json';
  if (flags.verbose) return 'verbose';
  return 'default';
}

/** Emit a success result. In JSON mode, prints `{ok:true,...payload}`. */
export function emitSuccess(
  io: IO,
  mode: OutputMode,
  line: string,
  payload: Record<string, unknown> = {},
): void {
  if (mode === 'json') {
    io.stdout(JSON.stringify({ ok: true, ...payload }));
    return;
  }
  io.stdout(line);
}

/** Emit an error and return the exit code (1). */
export function emitError(io: IO, mode: OutputMode, message: string, code = 1): number {
  if (mode === 'json') {
    io.stdout(JSON.stringify({ ok: false, error: message }));
  } else {
    io.stderr(`error: ${message}`);
  }
  return code;
}

/** Verbose-only diagnostic (always to stderr). Suppressed in default + json. */
export function emitDiag(io: IO, mode: OutputMode, message: string): void {
  if (mode === 'verbose') {
    io.stderr(message);
  }
}

/** Render a list of items, either as text rows or a JSON array. */
export function emitList<T>(
  io: IO,
  mode: OutputMode,
  items: T[],
  renderRow: (item: T) => string,
): void {
  if (mode === 'json') {
    io.stdout(JSON.stringify({ ok: true, items }));
    return;
  }
  if (items.length === 0) {
    io.stdout('(no items)');
    return;
  }
  for (const item of items) {
    io.stdout(renderRow(item));
  }
}
