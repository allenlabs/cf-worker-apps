import { describe, expect, it } from 'vitest';

import {
  copyToClipboard,
  defaultClipboardRunner,
  DEFAULT_CANDIDATES,
  type ClipboardRunner,
} from '../src/lib/ctx-clipboard.js';

interface Call { command: string; args: readonly string[]; payload: string }

function makeRunner(byCommand: Record<string, number>): { runner: ClipboardRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ClipboardRunner = async (command, args, payload) => {
    calls.push({ command, args, payload });
    return { code: byCommand[command] ?? 127 };
  };
  return { runner, calls };
}

describe('copyToClipboard', () => {
  it('returns the name of the first tool that succeeds', async () => {
    const { runner, calls } = makeRunner({ pbcopy: 0 });
    const tool = await copyToClipboard("cd '/x'", { runner });
    expect(tool).toBe('pbcopy');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: 'pbcopy', args: [], payload: "cd '/x'" });
  });

  it('falls through to wl-copy when pbcopy is missing', async () => {
    const { runner, calls } = makeRunner({ pbcopy: 127, 'wl-copy': 0 });
    const tool = await copyToClipboard('hi', { runner });
    expect(tool).toBe('wl-copy');
    expect(calls.map((c) => c.command)).toEqual(['pbcopy', 'wl-copy']);
  });

  it('falls through to xclip when both pbcopy + wl-copy fail', async () => {
    const { runner, calls } = makeRunner({ pbcopy: 127, 'wl-copy': 127, xclip: 0 });
    const tool = await copyToClipboard('hi', { runner });
    expect(tool).toBe('xclip');
    expect(calls.map((c) => c.command)).toEqual(['pbcopy', 'wl-copy', 'xclip']);
    expect(calls[2]!.args).toEqual(['-selection', 'clipboard']);
  });

  it('returns null when every candidate fails', async () => {
    const { runner } = makeRunner({});
    expect(await copyToClipboard('hi', { runner })).toBeNull();
  });

  it('accepts a custom candidate list', async () => {
    const { runner, calls } = makeRunner({ 'custom-copy': 0 });
    const tool = await copyToClipboard('x', {
      runner,
      candidates: [{ command: 'custom-copy', args: ['-q'] }],
    });
    expect(tool).toBe('custom-copy');
    expect(calls[0]!.args).toEqual(['-q']);
  });

  it('DEFAULT_CANDIDATES is in the documented priority order', () => {
    expect(DEFAULT_CANDIDATES.map((c) => c.command)).toEqual(['pbcopy', 'wl-copy', 'xclip']);
  });
});

describe('defaultClipboardRunner', () => {
  it('completes successfully for a real binary that consumes stdin', async () => {
    // `cat` reads stdin, writes to stdout (which we ignore), and exits 0.
    const r = await defaultClipboardRunner('cat', [], 'payload');
    expect(r.code).toBe(0);
  });
  it('returns 127 when the command is missing', async () => {
    const r = await defaultClipboardRunner('not-a-real-clipboard-binary-xyz', [], 'x');
    expect(r.code).toBe(127);
  });
  it('uses the default runner when no override is provided', async () => {
    // Passing no runner exercises the `?? defaultClipboardRunner` branch.
    // We hand it the always-failing list so the function returns null
    // without trying real binaries on the host.
    const tool = await copyToClipboard('x', {
      candidates: [{ command: 'definitely-missing-binary-xyz', args: [] }],
    });
    expect(tool).toBeNull();
  });
});
