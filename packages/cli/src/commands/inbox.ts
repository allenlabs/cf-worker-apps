// `al inbox` — capture + list + done/drop.
//
// Default subcommand (and `al "thought goes here"` shorthand) hits
// POST /v1/capture on inbox-api.  List/done/drop hit /v1/items.
// (The API surface for list/done/drop is being scaffolded alongside; we
// build the client side now so the CLI ships ready.)

/* v8 ignore start — wraps signedFetch + filesystem effects; covered by
   lib/* unit tests + manual smoke. */

import { loadConfig, requireApp } from '../lib/config.js';
import { signedFetch } from '../lib/hmac.js';
import { formatRelativeAge, truncate } from '../lib/humans.js';
import {
  emitDiag,
  emitError,
  emitList,
  emitSuccess,
  makeIO,
  resolveMode,
  type IO,
  type ModeFlags,
} from '../lib/output.js';

interface CaptureResponse {
  id: number;
  capturedAt: string;
}

interface InboxItem {
  id: number;
  text: string;
  source: string | null;
  tags: string[];
  status: string;
  capturedAt: string;
}

interface ListResponse {
  items: InboxItem[];
}

export async function captureCommand(
  text: string,
  flags: ModeFlags & { tag?: string[] } = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!text || text.trim().length === 0) {
    return emitError(io, mode, 'inbox capture requires non-empty text');
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'inbox');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  emitDiag(io, mode, `POST ${endpoint.url}/v1/capture`);
  const body = { text, source: 'cli', tags: flags.tag };
  const result = await signedFetch<CaptureResponse>(endpoint, '/v1/capture', {
    method: 'POST',
    body,
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitSuccess(io, mode, `✓ #${result.data.id}`, {
    id: result.data.id,
    capturedAt: result.data.capturedAt,
  });
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
    endpoint = requireApp(cfg, 'inbox');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<ListResponse>(endpoint, '/v1/items?status=unread', {
    method: 'GET',
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitList(io, mode, result.data.items, (item) =>
    `#${item.id}  ${truncate(item.text)}  · ${formatRelativeAge(Date.parse(item.capturedAt))}`,
  );
  return 0;
}

export async function transitionCommand(
  action: 'done' | 'drop',
  id: number,
  flags: ModeFlags = {},
  io: IO = makeIO(),
): Promise<number> {
  const mode = resolveMode(flags);
  if (!Number.isFinite(id) || id <= 0) {
    return emitError(io, mode, `invalid id: ${id}`);
  }
  const cfg = await loadConfig();
  let endpoint;
  try {
    endpoint = requireApp(cfg, 'inbox');
  } catch (err) {
    return emitError(io, mode, (err as Error).message);
  }
  const result = await signedFetch<{ id: number; status: string }>(endpoint, `/v1/items/${id}`, {
    method: 'PATCH',
    body: { action },
  });
  if (!result.ok || !result.data) {
    return emitError(io, mode, result.error ?? `HTTP ${result.status}`);
  }
  emitSuccess(io, mode, `✓ #${result.data.id} → ${result.data.status}`, {
    id: result.data.id,
    status: result.data.status,
  });
  return 0;
}

/* v8 ignore stop */
