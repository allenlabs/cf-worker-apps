// Shared Workers/Node publisher. The caller owns durable retry state beyond this invocation.
export const MAX_BATCH_BYTES = 480 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS_PER_BATCH = 128;
const sensitiveKey = /authorization|cookie|password|passwd|secret|token|api.?key|private.?key|jwt|^headers$/i;
const transientStatuses = new Set([429, 502, 503, 504]);
const utf8 = new TextEncoder();

/** Best-effort credential redaction, not a guarantee that arbitrary application data is safe. */
export function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, match => {
      try {
        const url = new URL(match);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[REDACTED URL]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]')
    .replace(/\b((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]');
}

export function redactTelemetry(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (depth >= 8 || seen.has(value)) return '[TRUNCATED]';
  seen.add(value);
  let clean;
  if (Array.isArray(value)) {
    clean = value.slice(0, 100).map(item => redactTelemetry(item, depth + 1, seen));
    if (value.length > 100) clean.push('[TRUNCATED]');
  } else {
    const entries = Object.entries(value);
    clean = Object.fromEntries(entries.slice(0, 100).map(([key, child]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactTelemetry(child, depth + 1, seen)]));
    if (entries.length > 100) clean['cf.observe.truncated'] = true;
  }
  seen.delete(value);
  return clean;
}

/** Validate every event before any network request, then split by actual serialized UTF-8 bytes. */
export function prepareBatches(events, sanitize = redactTelemetry) {
  if (!Array.isArray(events) || !events.length || events.length > 5000) throw new Error('Provide between 1 and 5000 events');
  const batches = [];
  let parts = [], bytes = 2, inputBytes = 0;
  const flush = () => { batches.push({ body: `[${parts.join(',')}]`, events: parts.length }); parts = []; bytes = 2; };
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Every event must be an object');
    const clean = sanitize(event);
    if (!clean || typeof clean !== 'object' || Array.isArray(clean)) throw new Error('The sanitizer must return an event object');
    const serialized = JSON.stringify(clean);
    const size = utf8.encode(serialized).byteLength;
    if (size > MAX_EVENT_BYTES) throw new Error('An event exceeds 256 KiB; reduce the record at its source');
    inputBytes += size;
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('The input exceeds 8 MiB; publish smaller exports');
    if (parts.length && (parts.length >= MAX_EVENTS_PER_BATCH || bytes + size + 1 > MAX_BATCH_BYTES)) flush();
    bytes += size + (parts.length ? 1 : 0);
    parts.push(serialized);
  }
  if (parts.length) flush();
  return batches;
}

function destination(url, binding) {
  const target = new URL('/api/ingest', binding ? 'https://cf-observe.internal' : url);
  const supplied = binding ? target : new URL(url);
  if (supplied.username || supplied.password) throw new Error('Do not put credentials in the ingestion URL');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error('Use HTTPS, or HTTP on loopback for local development');
  return target;
}

async function readReceipt(response) {
  if (!response.body) throw new Error('Empty ingestion receipt');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) throw new Error('Ingestion receipt exceeds 16 KiB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(combined));
}

function retryDelay(response, attempt) {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, Math.min(8000, ms));
  }
  return Math.min(8000, 250 * 2 ** attempt);
}

/**
 * Await this when telemetry failure must be visible. waitUntil is best effort, not a durable outbox.
 * Reuse a persisted idempotencyKey AND the exact same events/options after caller restarts.
 */
export async function publishEvents({ url, binding, token, events, idempotencyKey = crypto.randomUUID(), attempts = 4, fetcher = fetch, sanitize = redactTelemetry, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Missing ingestion secret');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8) throw new Error('attempts must be between 1 and 8');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 256) throw new Error('Provide an Idempotency-Key of 1 to 256 characters');
  const endpoint = destination(url, binding);
  const batches = prepareBatches(events, sanitize);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(idempotencyKey)));
  const exportId = Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
  const send = binding ? binding.fetch.bind(binding) : fetcher;
  const receipts = [];
  for (const [index, batch] of batches.entries()) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await send(endpoint, {
          method: 'POST', redirect: 'manual',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `publisher-v1:${exportId}:${index}` },
          body: batch.body, signal: AbortSignal.timeout(10000)
        });
        if (response.ok) { receipts.push(await readReceipt(response)); lastError = null; break; }
        lastError = new Error(`Telemetry ingestion returned HTTP ${response.status}`);
        lastError.status = response.status;
        await response.body?.cancel();
        if (!transientStatuses.has(response.status)) { lastError.permanent = true; throw lastError; }
      } catch (error) {
        if (error.permanent) throw error;
        lastError = error;
      }
      if (attempt + 1 < attempts) await sleep(retryDelay(response, attempt));
    }
    if (lastError) throw lastError;
  }
  return { events: events.length, batches: batches.length, receipts };
}
