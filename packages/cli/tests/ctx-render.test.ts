import { describe, expect, it } from 'vitest';

import {
  asLines,
  asString,
  cdCommand,
  formatHeader,
  formatListRow,
  renderRestore,
  type SnapshotDetail,
  type SnapshotSummary,
} from '../src/lib/ctx-render.js';

const NOW = Date.UTC(2026, 4, 24, 12, 0, 0);

function detail(overrides: Partial<SnapshotDetail> = {}): SnapshotDetail {
  return {
    id: 42,
    name: 'fixing auth bug',
    notes: null,
    payload: {},
    createdAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    restoredAt: null,
    restoredCount: 0,
    ...overrides,
  };
}

describe('asString', () => {
  it('passes through a non-empty string', () => {
    expect(asString('hi')).toBe('hi');
  });
  it('returns null for an empty string', () => {
    expect(asString('')).toBeNull();
  });
  it('joins a string array', () => {
    expect(asString(['a', 'b'])).toBe('a\nb');
  });
  it('filters non-strings out of an array', () => {
    expect(asString(['a', 7, '', 'b'])).toBe('a\nb');
  });
  it('returns null for an array with no strings', () => {
    expect(asString([7, null, undefined])).toBeNull();
  });
  it('returns null for unrecognised input', () => {
    expect(asString({ x: 1 })).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
  });
});

describe('asLines', () => {
  it('splits and trims', () => {
    expect(asLines(' a \n b ')).toEqual(['a', 'b']);
  });
  it('drops empty rows', () => {
    expect(asLines('a\n\nb')).toEqual(['a', 'b']);
  });
  it('handles array input', () => {
    expect(asLines(['x', 'y'])).toEqual(['x', 'y']);
  });
  it('returns null for null/garbage', () => {
    expect(asLines(null)).toBeNull();
  });
  it('returns null when input is all whitespace', () => {
    expect(asLines('   \n   ')).toBeNull();
  });
});

describe('formatHeader', () => {
  it('shows "never restored" when restoredCount is 0', () => {
    const h = formatHeader(detail(), NOW);
    expect(h).toBe("↩ ctx #42 'fixing auth bug'  (3h ago, never restored)");
  });
  it('shows the restored window when restoredCount > 0', () => {
    const h = formatHeader(
      detail({
        restoredCount: 3,
        restoredAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(h).toBe(
      "↩ ctx #42 'fixing auth bug'  (saved 3h ago, last restored 2h ago, 3 restores)",
    );
  });
  it('pluralises "restore" → "restores" correctly for 1', () => {
    const h = formatHeader(
      detail({
        restoredCount: 1,
        restoredAt: new Date(NOW - 5 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(h).toContain('1 restore)');
    expect(h).not.toContain('1 restores');
  });
  it('falls back to "never restored" when restoredCount > 0 but restoredAt is null', () => {
    const h = formatHeader(detail({ restoredCount: 3, restoredAt: null }), NOW);
    expect(h).toContain('never restored');
  });
  it('defaults `now` to Date.now() when not passed', () => {
    expect(typeof formatHeader(detail())).toBe('string');
  });
});

describe('renderRestore', () => {
  it('emits a clipboard-copied cwd line when the tool succeeded', () => {
    const lines = renderRestore(
      detail({
        payload: { cwd: '/home/u/proj', branch: 'main' },
      }),
      { clipboardTool: 'wl-copy', now: NOW },
    );
    expect(lines[0]).toContain('↩ ctx #42');
    expect(lines[1]).toContain('📁 /home/u/proj');
    expect(lines[1]).toContain('(cd command copied via wl-copy)');
    expect(lines[2]).toContain('🌿 main');
  });

  it('falls back to `run: cd <path>` when clipboard was unavailable', () => {
    const lines = renderRestore(
      detail({ payload: { cwd: '/x' } }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines[1]).toContain('(run: cd /x)');
  });

  it('emits a tmux line when payload.tmux is present', () => {
    const lines = renderRestore(
      detail({ payload: { tmux: ['claude', 'code', 'db'] } }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines.some((l) => l.startsWith('📦 tmux windows: claude, code, db'))).toBe(true);
  });

  it('emits a recent-files line and caps at 10', () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const lines = renderRestore(
      detail({ payload: { files: many } }),
      { clipboardTool: null, now: NOW },
    );
    const filesLine = lines.find((l) => l.startsWith('📝 Recent files:'))!;
    expect(filesLine.split(', ')).toHaveLength(10);
  });

  it('emits a git-status block (singular) when there is 1 change', () => {
    const lines = renderRestore(
      detail({ payload: { git_status: ' M README.md' } }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines.some((l) => l.startsWith('🌀 git status (1 change):'))).toBe(true);
  });

  it('emits a git-status block (plural) and caps at 10 rows', () => {
    const many = Array.from({ length: 20 }, (_, i) => `?? f${i}.ts`).join('\n');
    const lines = renderRestore(
      detail({ payload: { git_status: many } }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines.some((l) => l.startsWith('🌀 git status (20 changes):'))).toBe(true);
    const indented = lines.filter((l) => l.startsWith('     '));
    expect(indented).toHaveLength(10);
  });

  it('renders the note when present', () => {
    const lines = renderRestore(
      detail({ notes: 'stuck on JWKS cache' }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines.some((l) => l === '📝 note: stuck on JWKS cache')).toBe(true);
  });

  it('omits all decoration lines when the payload has nothing recognisable', () => {
    const lines = renderRestore(
      detail({ payload: { unknown: 'ignored' } }),
      { clipboardTool: null, now: NOW },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('↩ ctx #42');
  });
});

describe('formatListRow', () => {
  it('shows "never restored" when restoredCount is 0', () => {
    const row: SnapshotSummary = {
      id: 12,
      name: 'audit log',
      createdAt: new Date(NOW - 10 * 60_000).toISOString(),
      restoredAt: null,
      restoredCount: 0,
    };
    expect(formatListRow(row, NOW)).toBe('#12  audit log  10m ago  (never restored)');
  });
  it('uses the singular "restore" for 1', () => {
    const row: SnapshotSummary = {
      id: 1,
      name: 'x',
      createdAt: new Date(NOW - 60_000).toISOString(),
      restoredAt: new Date(NOW).toISOString(),
      restoredCount: 1,
    };
    expect(formatListRow(row, NOW)).toContain('(1 restore)');
  });
  it('uses the plural "restores" for >1', () => {
    const row: SnapshotSummary = {
      id: 1,
      name: 'x',
      createdAt: new Date(NOW - 60_000).toISOString(),
      restoredAt: new Date(NOW).toISOString(),
      restoredCount: 7,
    };
    expect(formatListRow(row, NOW)).toContain('(7 restores)');
  });
  it('defaults `now` to Date.now()', () => {
    const row: SnapshotSummary = {
      id: 1,
      name: 'x',
      createdAt: new Date().toISOString(),
      restoredAt: null,
      restoredCount: 0,
    };
    expect(typeof formatListRow(row)).toBe('string');
  });
});

describe('cdCommand', () => {
  it('single-quotes a plain path', () => {
    expect(cdCommand('/home/u/proj')).toBe("cd '/home/u/proj'");
  });
  it('escapes embedded single quotes correctly', () => {
    expect(cdCommand("/it's/a/trap")).toBe("cd '/it'\\''s/a/trap'");
  });
});
