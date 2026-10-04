// `al ctx` — save / restore / list / delete a context snapshot.
//
// All the heavy lifting (capture, render, clipboard) lives in
// src/lib/ctx-* so it's unit-testable; this file is thin network glue
// in the same style as inbox.ts / focus.ts.

/* v8 ignore start — wraps signedFetch + child_process + filesystem
   effects; covered by lib/* unit tests + manual smoke. */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, requireApp } from '../lib/config.js';
import { signedFetch } from '../lib/hmac.js';
import {
  emitDiag,
  emitError,
  emitSuccess,
  makeIO,
  resolveMode,
  type IO,
  type ModeFlags,
} from '../lib/output.js';
import { captureContext } from '../lib/ctx-capture.js';
import { copyToClipboard } from '../lib/ctx-clipboard.js';
import {
  cdCommand,
  formatListRow,
  renderRestore,
  type SnapshotDetail,
  type SnapshotSummary,
} from '../lib/ctx-render.js';

interface SaveResponse {
  id: number;
  name: string;
  createdAt: string;
}

interface ListResponse {
  snapshots: SnapshotSummary[];
}

export interface SaveFlags extends ModeFlags {
  note?: string;
  focusSession?: string;
  inboxItem?: string;
  pmIssue?: string;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined;
  return n;
}

export async function saveCommand(
  name: string,
  flags: SaveFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!name || name.trim().length === 0) {
    return emitError(io, mode, 'ctx save requires a name');
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'context');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const { context, sources } = await captureContext();
  emitDiag(io, mode, `captured: ${sources.join(', ') || '(nothing)'}`);

  const body: Record<string, unknown> = {
    name: name.trim(),
    payload: context,
  };
  if (flags.note && flags.note.length > 0) body.notes = flags.note;
  const fs = parsePositiveInt(flags.focusSession);
  if (fs !== undefined) body.focusSessionId = fs;
  const ii = parsePositiveInt(flags.inboxItem);
  if (ii !== undefined) body.inboxItemId = ii;
  const pm = parsePositiveInt(flags.pmIssue);
  if (pm !== undefined) body.pmIssueId = pm;

  emitDiag(io, mode, `POST ${endpoint.url}/v1/save`);
  const result = await signedFetch<SaveResponse>(endpoint, '/v1/save', {
    method: 'POST',
    body,
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitSuccess(
    io,
    mode,
    `✓ ctx #${result.data.id} saved (${sources.join(', ')})`,
    {
      id: result.data.id,
      name: result.data.name,
      createdAt: result.data.createdAt,
      sources,
    },
  );
  return 0;
}

export interface RestoreFlags extends ModeFlags {
  printOnly?: boolean;
}

async function resolveSnapshotByName(
  endpoint: { url: string; client_id: string; secret: string },
  name: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  // The API has no name-filter query param yet, so we list everything
  // and filter client-side.  20 is fine — the typical user has <20
  // active snapshots; long history doesn't need to be addressable by
  // name (use the numeric id).
  const list = await signedFetch<ListResponse>(endpoint, '/v1/list?limit=100', {
    method: 'GET',
  });
  if (!list.ok || !list.data) {
    return { ok: false, error: list.error ?? `HTTP ${list.status}` };
  }
  const hits = list.data.snapshots.filter((s) => s.name === name);
  if (hits.length === 0) {
    return { ok: false, error: `no snapshot named '${name}'` };
  }
  // Newest first (the API already orders by createdAt DESC).
  const head = hits[0]!;
  return { ok: true, id: head.id };
}

export async function restoreCommand(
  arg: string,
  flags: RestoreFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!arg || arg.trim().length === 0) {
    return emitError(io, mode, 'ctx restore requires a name or id');
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'context');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }

  let id: number;
  if (/^[0-9]+$/.test(arg.trim())) {
    id = Number(arg.trim());
  } else {
    const r = await resolveSnapshotByName(endpoint, arg.trim());
    if (!r.ok) return emitError(io, mode, r.error);
    id = r.id;
  }

  // Bump restored_at + restored_count.  The response is the full
  // post-bump detail row, so we don't need a second GET.
  const result = await signedFetch<SnapshotDetail>(endpoint, `/v1/${id}/restore`, {
    method: 'POST',
    body: {},
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }

  const detail = result.data;
  let clipboardTool: string | null = null;
  if (!flags.printOnly) {
    const cwd = typeof detail.payload?.cwd === 'string' ? detail.payload.cwd : null;
    if (cwd) {
      clipboardTool = await copyToClipboard(cdCommand(cwd));
    }
  }

  if (mode === 'json') {
    io.stdout(JSON.stringify({ ok: true, snapshot: detail, clipboardTool }));
    return 0;
  }
  for (const line of renderRestore(detail, { clipboardTool })) {
    io.stdout(line);
  }
  return 0;
}

export async function listCommand(
  flags: ModeFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'context');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<ListResponse>(endpoint, '/v1/list?limit=20', {
    method: 'GET',
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  if (mode === 'json') {
    io.stdout(JSON.stringify({ ok: true, snapshots: result.data.snapshots }));
    return 0;
  }
  const snaps = result.data.snapshots;
  if (snaps.length === 0) {
    io.stdout('(no snapshots)');
    return 0;
  }
  for (const s of snaps) {
    io.stdout(formatListRow(s));
  }
  return 0;
}

export interface DeleteFlags extends ModeFlags {
  yes?: boolean;
}

export async function deleteCommand(
  rawId: string,
  flags: DeleteFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  const id = parsePositiveInt(rawId);
  if (id === undefined) {
    return emitError(io, mode, `invalid id: ${rawId}`);
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'context');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }

  if (!flags.yes && mode !== 'json' && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question(`delete ctx #${id}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') {
      io.stdout('(cancelled)');
      return 0;
    }
  }

  const result = await signedFetch<{ deleted: number }>(endpoint, `/v1/${id}`, {
    method: 'DELETE',
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitSuccess(io, mode, `✓ ctx #${result.data.deleted} deleted`, { id: result.data.deleted });
  return 0;
}

/* v8 ignore stop */
