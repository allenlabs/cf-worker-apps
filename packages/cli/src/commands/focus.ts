// `al focus` — start / stop / distract / status.
//
// Mirrors `apps/focus/`'s API surface (being scaffolded in parallel):
//   POST /v1/sessions             { text, target_minutes } → { id, startedAt, ... }
//   POST /v1/sessions/:id/stop    → { id, endedAt }
//   POST /v1/sessions/:id/distract { label } → { ok }
//   GET  /v1/sessions/current     → { session | null }
//
// We also keep a local copy of the active session (lib/session-store)
// so `al focus status` and `al shell-prompt` are zero-latency.

/* v8 ignore start — same rationale as inbox.ts (filesystem + network). */

import { loadConfig, requireApp } from '../lib/config.js';
import { signedFetch } from '../lib/hmac.js';
import { formatClock, formatSessionWindow } from '../lib/humans.js';
import {
  emitError,
  emitSuccess,
  makeIO,
  resolveMode,
  type IO,
  type ModeFlags,
} from '../lib/output.js';
import {
  clearSession,
  loadSession,
  saveSession,
  type ActiveSession,
} from '../lib/session-store.js';

interface StartResponse {
  id: number;
  text: string;
  startedAt: string;
  targetMinutes: number;
}

interface StopResponse {
  id: number;
  endedAt: string;
}

export async function startCommand(
  text: string,
  targetMinutes = 25,
  flags: ModeFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!text || text.trim().length === 0) {
    return emitError(io, mode, 'focus start requires a task description');
  }
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0) {
    return emitError(io, mode, `invalid duration: ${targetMinutes}`);
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'focus');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<StartResponse>(endpoint, '/v1/sessions', {
    method: 'POST',
    body: { text, target_minutes: targetMinutes },
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  const startedAtMs = Date.parse(result.data.startedAt);
  const endsAt = startedAtMs + result.data.targetMinutes * 60_000;
  const session: ActiveSession = {
    id: result.data.id,
    text: result.data.text,
    startedAt: startedAtMs,
    targetMinutes: result.data.targetMinutes,
  };
  await saveSession(session);
  emitSuccess(
    io,
    mode,
    `✓ focus #${result.data.id}  ${formatSessionWindow(result.data.targetMinutes, endsAt)}`,
    { id: result.data.id, targetMinutes: result.data.targetMinutes, endsAt },
  );
  return 0;
}

export async function stopCommand(flags: ModeFlags = {}, io: IO = makeIO()): Promise<number> {
  const mode = resolveMode(flags);
  const local = await loadSession();
  if (!local) {
    return emitError(io, mode, 'no active focus session');
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'focus');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<StopResponse>(endpoint, `/v1/sessions/${local.id}/stop`, {
    method: 'POST',
    body: {},
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  await clearSession();
  emitSuccess(io, mode, `✓ focus #${result.data.id} stopped`, {
    id: result.data.id,
    endedAt: result.data.endedAt,
  });
  return 0;
}

export async function distractCommand(
  label: string,
  flags: ModeFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!label || label.trim().length === 0) {
    return emitError(io, mode, 'distract requires a label');
  }
  const local = await loadSession();
  if (!local) {
    return emitError(io, mode, 'no active focus session');
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'focus');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<{ ok: true }>(endpoint, `/v1/sessions/${local.id}/distract`, {
    method: 'POST',
    body: { label },
  });
  if (!result.ok) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitSuccess(io, mode, `✓ logged: ${label}`, { id: local.id, label });
  return 0;
}

export async function statusCommand(flags: ModeFlags = {}, io: IO = makeIO()): Promise<number> {
  const mode = resolveMode(flags);
  const local = await loadSession();
  if (!local) {
    if (mode === 'json') {
      io.stdout(JSON.stringify({ ok: true, session: null }));
    } else {
      io.stdout('(no active focus session)');
    }
    return 0;
  }
  const endsAt = local.startedAt + local.targetMinutes * 60_000;
  if (mode === 'json') {
    io.stdout(JSON.stringify({
      ok: true,
      session: {
        id: local.id,
        text: local.text,
        startedAt: local.startedAt,
        targetMinutes: local.targetMinutes,
        endsAt,
      },
    }));
    return 0;
  }
  io.stdout(
    `focus #${local.id}  "${local.text}"  ${formatSessionWindow(local.targetMinutes, endsAt)}  · ends at ${formatClock(endsAt)}`,
  );
  return 0;
}

/* v8 ignore stop */
