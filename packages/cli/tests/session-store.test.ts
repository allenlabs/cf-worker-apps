import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearSession,
  loadSession,
  normalizeSession,
  saveSession,
  sessionPath,
} from '../src/lib/session-store.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'allenlabs-session-test-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

const VALID = { id: 7, text: 'fix 502s', startedAt: 1_700_000_000_000, targetMinutes: 25 };

describe('sessionPath', () => {
  it('respects XDG_STATE_HOME', () => {
    expect(sessionPath({ XDG_STATE_HOME: '/s' }, '/h')).toBe('/s/allenlabs/focus-session.json');
  });
  it('falls back to ~/.local/state', () => {
    expect(sessionPath({}, '/h')).toBe('/h/.local/state/allenlabs/focus-session.json');
  });
  it('falls back when XDG empty', () => {
    expect(sessionPath({ XDG_STATE_HOME: '' }, '/h')).toBe('/h/.local/state/allenlabs/focus-session.json');
  });
});

describe('loadSession', () => {
  it('returns null when missing', async () => {
    expect(await loadSession(join(workDir, 'nope.json'))).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    const p = join(workDir, 'bad.json');
    await fs.writeFile(p, 'not json');
    expect(await loadSession(p)).toBeNull();
  });
  it('returns null on wrong-shape JSON', async () => {
    const p = join(workDir, 'shape.json');
    await fs.writeFile(p, JSON.stringify({ id: 'string' }));
    expect(await loadSession(p)).toBeNull();
  });
  it('reads a valid session', async () => {
    const p = join(workDir, 'ok.json');
    await fs.writeFile(p, JSON.stringify(VALID));
    expect(await loadSession(p)).toEqual(VALID);
  });
  it('re-throws non-ENOENT non-syntax errors', async () => {
    await expect(loadSession(workDir)).rejects.toBeInstanceOf(Error);
  });
});

describe('saveSession / clearSession', () => {
  it('round-trips', async () => {
    const p = join(workDir, 'rt.json');
    await saveSession(VALID, p);
    expect(await loadSession(p)).toEqual(VALID);
  });
  it('creates parent dirs', async () => {
    const p = join(workDir, 'a', 'b', 'rt.json');
    await saveSession(VALID, p);
    expect(await loadSession(p)).toEqual(VALID);
  });
  it('clearSession removes a present file', async () => {
    const p = join(workDir, 'rt.json');
    await saveSession(VALID, p);
    await clearSession(p);
    expect(await loadSession(p)).toBeNull();
  });
  it('clearSession is a no-op if missing', async () => {
    await clearSession(join(workDir, 'never-existed.json'));
  });
  it('clearSession rethrows non-ENOENT errors', async () => {
    // Deleting a directory via unlink → EISDIR.
    await expect(clearSession(workDir)).rejects.toBeInstanceOf(Error);
  });
});

describe('normalizeSession', () => {
  it('returns null for non-object', () => {
    expect(normalizeSession(null)).toBeNull();
    expect(normalizeSession(42)).toBeNull();
    expect(normalizeSession('s')).toBeNull();
  });
  it('returns null when any field is wrong type', () => {
    expect(normalizeSession({ ...VALID, id: '7' })).toBeNull();
    expect(normalizeSession({ ...VALID, text: 1 })).toBeNull();
    expect(normalizeSession({ ...VALID, startedAt: '0' })).toBeNull();
    expect(normalizeSession({ ...VALID, targetMinutes: '25' })).toBeNull();
  });
  it('returns the canonical shape when valid', () => {
    expect(normalizeSession({ ...VALID, extra: 'ignored' })).toEqual(VALID);
  });
});
