// Local cache of the currently-active focus session.
//
// Why a local cache?  `al focus status` runs on every prompt (via
// `shell-prompt`) — we cannot afford a network round-trip.  We mirror
// the server's truth here: when `start` succeeds, write; when `stop`
// succeeds (or returns 404), clear.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ActiveSession {
  id: number;
  text: string;
  startedAt: number;       // ms since epoch
  targetMinutes: number;
}

export function sessionPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.local', 'state');
  return join(base, 'allenlabs', 'focus-session.json');
}

/** Read the active session, or null if none / unreadable. */
export async function loadSession(path: string = sessionPath()): Promise<ActiveSession | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return normalizeSession(parsed);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function saveSession(s: ActiveSession, path: string = sessionPath()): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, path);
}

export async function clearSession(path: string = sessionPath()): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}

export function normalizeSession(input: unknown): ActiveSession | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (
    typeof o.id !== 'number' ||
    typeof o.text !== 'string' ||
    typeof o.startedAt !== 'number' ||
    typeof o.targetMinutes !== 'number'
  ) {
    return null;
  }
  return {
    id: o.id,
    text: o.text,
    startedAt: o.startedAt,
    targetMinutes: o.targetMinutes,
  };
}
