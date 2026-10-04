import { describe, expect, it } from 'vitest';

import {
  captureContext,
  defaultEnv,
  defaultRunner,
  lines,
  truncateLines,
  type CaptureRunResult,
  type CaptureRunner,
} from '../src/lib/ctx-capture.js';

interface StubCall { command: string; args: readonly string[] }

function makeRunner(
  byCommand: Record<string, CaptureRunResult>,
): { runner: CaptureRunner; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const runner: CaptureRunner = async (command, args) => {
    calls.push({ command, args });
    const key = command;
    return byCommand[key] ?? { code: 127, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('lines', () => {
  it('splits and drops empty rows', () => {
    expect(lines('a\nb\n\n')).toEqual(['a', 'b']);
  });
  it('strips trailing \\r', () => {
    expect(lines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('truncateLines', () => {
  it('caps at the requested row count', () => {
    expect(truncateLines('1\n2\n3\n4\n5', 3)).toBe('1\n2\n3');
  });
  it('returns all rows when below the cap', () => {
    expect(truncateLines('1\n2', 5)).toBe('1\n2');
  });
  it('returns empty string when input has no content', () => {
    expect(truncateLines('', 10)).toBe('');
  });
});

describe('defaultRunner', () => {
  it('captures stdout from a real subprocess', async () => {
    const r = await defaultRunner('printf', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello');
  });
  it('returns 127 when the command does not exist', async () => {
    const r = await defaultRunner('definitely-not-a-real-binary-xyz', []);
    expect(r.code).toBe(127);
  });
  it('forwards a non-zero exit code', async () => {
    const r = await defaultRunner('sh', ['-c', 'echo err 1>&2; exit 3']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('err');
  });
});

describe('defaultEnv', () => {
  it('exposes process.cwd and process.env', () => {
    expect(defaultEnv.cwd()).toBe(process.cwd());
    expect(defaultEnv.env).toBe(process.env);
  });
});

describe('captureContext', () => {
  const fullStubs: Record<string, CaptureRunResult> = {
    git: { code: 0, stdout: 'main\n', stderr: '' },
    tmux: { code: 0, stdout: 'one\ntwo\n', stderr: '' },
    ls: { code: 0, stdout: 'a\nb\nc\n', stderr: '' },
    ps: { code: 0, stdout: 'PID COMM\n1 init\n2 sshd\n', stderr: '' },
  };

  it('captures every source when all tools succeed and $TMUX is set', async () => {
    // git runs twice (rev-parse + status).  Track calls by branching the
    // response based on the second positional arg.
    const calls: StubCall[] = [];
    const runner: CaptureRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === 'git' && args[0] === 'rev-parse') {
        return { code: 0, stdout: 'feature/x\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'status') {
        return { code: 0, stdout: ' M file.ts\n?? new.ts\n', stderr: '' };
      }
      if (command === 'tmux') return fullStubs.tmux!;
      if (command === 'ls') return fullStubs.ls!;
      if (command === 'ps') return fullStubs.ps!;
      return { code: 127, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: {
        cwd: () => '/home/dev/proj',
        env: { TMUX: '/tmp/tmux-1000/default,2,0' },
      },
    });
    expect(out.context.cwd).toBe('/home/dev/proj');
    expect(out.context.branch).toBe('feature/x');
    expect(out.context.git_status).toBe(' M file.ts\n?? new.ts');
    expect(out.context.tmux).toBe('one\ntwo');
    expect(out.context.files).toBe('a\nb\nc');
    expect(out.context.processes).toBe('PID COMM\n1 init\n2 sshd');
    expect(out.sources).toEqual(['cwd', 'branch', 'git_status', 'tmux', 'files', 'processes']);
    // ls runs with the cwd appended.
    const lsCall = calls.find((c) => c.command === 'ls')!;
    expect(lsCall.args).toEqual(['-t', '/home/dev/proj']);
  });

  it('skips branch when git rev-parse fails (no repo)', async () => {
    const runner: CaptureRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repo' };
      }
      if (command === 'git' && args[0] === 'status') {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repo' };
      }
      if (command === 'ls') return { code: 0, stdout: 'a\n', stderr: '' };
      if (command === 'ps') return { code: 0, stdout: 'x\n', stderr: '' };
      return { code: 127, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/tmp/proj', env: {} },
    });
    expect(out.context.branch).toBeUndefined();
    expect(out.context.git_status).toBeUndefined();
    expect(out.context.tmux).toBeUndefined();
    expect(out.sources).toEqual(['cwd', 'files', 'processes']);
  });

  it('skips branch when git rev-parse returns empty stdout', async () => {
    const runner: CaptureRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '   \n', stderr: '' };
      if (command === 'git' && args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (command === 'ls') return { code: 1, stdout: '', stderr: '' };
      if (command === 'ps') return { code: 1, stdout: '', stderr: '' };
      return { code: 127, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/tmp/proj', env: {} },
    });
    expect(out.context.branch).toBeUndefined();
    expect(out.context.git_status).toBeUndefined();
    expect(out.sources).toEqual(['cwd']);
  });

  it('skips tmux when $TMUX is unset', async () => {
    const { runner } = makeRunner({
      git: { code: 1, stdout: '', stderr: '' },
      ls: { code: 1, stdout: '', stderr: '' },
      ps: { code: 1, stdout: '', stderr: '' },
    });
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: { TMUX: '' } },
    });
    expect(out.context.tmux).toBeUndefined();
    expect(out.sources).toEqual(['cwd']);
  });

  it('skips tmux when the binary is missing', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'tmux') return { code: 127, stdout: '', stderr: 'no tmux' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: { TMUX: 'set' } },
    });
    expect(out.context.tmux).toBeUndefined();
  });

  it('skips tmux when tmux returns empty stdout (no windows)', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'tmux') return { code: 0, stdout: '\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: { TMUX: 'set' } },
    });
    expect(out.context.tmux).toBeUndefined();
    expect(out.sources).not.toContain('tmux');
  });

  it('skips git_status when porcelain output is empty (clean tree)', async () => {
    const runner: CaptureRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'main', stderr: '' };
      if (command === 'git' && args[0] === 'status') return { code: 0, stdout: '\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.git_status).toBeUndefined();
    expect(out.sources).toEqual(['cwd', 'branch']);
  });

  it('skips files when ls fails', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'ls') return { code: 1, stdout: 'should-be-ignored', stderr: 'permission denied' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.files).toBeUndefined();
  });

  it('skips files when ls returns empty stdout', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'ls') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.files).toBeUndefined();
  });

  it('skips processes when ps fails', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'ps') return { code: 127, stdout: '', stderr: 'no ps' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.processes).toBeUndefined();
  });

  it('skips processes when ps returns empty stdout', async () => {
    const runner: CaptureRunner = async (command) => {
      if (command === 'ps') return { code: 0, stdout: '   \n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.processes).toBeUndefined();
  });

  it('skips cwd when the env returns an empty string', async () => {
    const runner: CaptureRunner = async () => ({ code: 1, stdout: '', stderr: '' });
    const out = await captureContext({
      runner,
      env: { cwd: () => '', env: {} },
    });
    expect(out.context.cwd).toBeUndefined();
    expect(out.sources).toEqual([]);
  });

  it('truncates git_status to 30 rows', async () => {
    const big = Array.from({ length: 100 }, (_, i) => `?? f${i}.ts`).join('\n');
    const runner: CaptureRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'main', stderr: '' };
      if (command === 'git' && args[0] === 'status') return { code: 0, stdout: big, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const out = await captureContext({
      runner,
      env: { cwd: () => '/x', env: {} },
    });
    expect(out.context.git_status!.split('\n')).toHaveLength(30);
  });

  it('uses default runner + env when no options are passed', async () => {
    // Smoke test: just ensure the default-args path doesn't throw and
    // produces a CapturedContext with at least cwd populated (always
    // available).  We don't assert the other sources because they
    // depend on the host.
    const out = await captureContext();
    expect(out.sources).toContain('cwd');
    expect(typeof out.context.cwd).toBe('string');
  });
});
