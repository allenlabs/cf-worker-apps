import { describe, expect, it, vi } from 'vitest';

import {
  emitDiag,
  emitError,
  emitList,
  emitSuccess,
  makeIO,
  resolveMode,
  type IO,
} from '../src/lib/output.js';

function captureIO(): IO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
  };
}

describe('resolveMode', () => {
  it('json wins over verbose', () => {
    expect(resolveMode({ json: true, verbose: true })).toBe('json');
  });
  it('verbose when no json', () => {
    expect(resolveMode({ verbose: true })).toBe('verbose');
  });
  it('default when neither', () => {
    expect(resolveMode({})).toBe('default');
  });
});

describe('makeIO', () => {
  it('returns a wrapper with defaults that hit process streams', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const io = makeIO();
    io.stdout('hello');
    io.stderr('world');
    expect(writeSpy).toHaveBeenCalledWith('hello\n');
    expect(errSpy).toHaveBeenCalledWith('world\n');
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });
  it('accepts overrides', () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = makeIO((s) => out.push(s), (s) => err.push(s));
    io.stdout('a'); io.stderr('b');
    expect(out).toEqual(['a']);
    expect(err).toEqual(['b']);
  });
});

describe('emitSuccess', () => {
  it('default mode prints the line', () => {
    const io = captureIO();
    emitSuccess(io, 'default', '✓ #42');
    expect(io.out).toEqual(['✓ #42']);
    expect(io.err).toEqual([]);
  });
  it('verbose mode also just prints the line (diagnostics go elsewhere)', () => {
    const io = captureIO();
    emitSuccess(io, 'verbose', '✓ #42');
    expect(io.out).toEqual(['✓ #42']);
  });
  it('json mode prints structured payload with payload extras', () => {
    const io = captureIO();
    emitSuccess(io, 'json', 'ignored', { id: 42 });
    expect(io.out).toEqual([JSON.stringify({ ok: true, id: 42 })]);
  });
});

describe('emitError', () => {
  it('default mode prints to stderr and returns 1', () => {
    const io = captureIO();
    const code = emitError(io, 'default', 'boom');
    expect(code).toBe(1);
    expect(io.err).toEqual(['error: boom']);
    expect(io.out).toEqual([]);
  });
  it('json mode prints to stdout', () => {
    const io = captureIO();
    const code = emitError(io, 'json', 'boom');
    expect(code).toBe(1);
    expect(io.out).toEqual([JSON.stringify({ ok: false, error: 'boom' })]);
    expect(io.err).toEqual([]);
  });
  it('respects a custom exit code', () => {
    const io = captureIO();
    expect(emitError(io, 'default', 'x', 2)).toBe(2);
  });
});

describe('emitDiag', () => {
  it('only fires in verbose mode', () => {
    const io = captureIO();
    emitDiag(io, 'default', 'noop');
    emitDiag(io, 'json', 'noop');
    expect(io.err).toEqual([]);
    emitDiag(io, 'verbose', 'POST /capture');
    expect(io.err).toEqual(['POST /capture']);
  });
});

describe('emitList', () => {
  it('renders rows in default mode', () => {
    const io = captureIO();
    emitList(io, 'default', [1, 2], (n) => `row ${n}`);
    expect(io.out).toEqual(['row 1', 'row 2']);
  });
  it('shows placeholder when empty', () => {
    const io = captureIO();
    emitList(io, 'default', [], () => 'x');
    expect(io.out).toEqual(['(no items)']);
  });
  it('emits structured JSON in json mode', () => {
    const io = captureIO();
    emitList(io, 'json', [{ id: 1 }], () => 'x');
    expect(io.out).toEqual([JSON.stringify({ ok: true, items: [{ id: 1 }] })]);
  });
});
