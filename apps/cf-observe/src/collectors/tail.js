import { publishEvents, redactTelemetry, redactText } from './publisher.js';

const EXCLUDED = new Set(['cf-observe', 'cf-observe-tail']);
const MAX_LOGS = 128;
const MAX_EXCEPTIONS = 16;
const MAX_MESSAGE_CHARS = 8192;

function timestamp(value, fallback) {
  const time = value instanceof Date ? value.valueOf() : value;
  return typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 8640000000000000 ? time : fallback;
}
function message(value, sanitize) {
  const clean = sanitize(value);
  const text = typeof clean === 'string' ? clean : JSON.stringify(clean) ?? '';
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} [TRUNCATED]` : text;
}
function pathname(value) {
  try {
    return redactText(new URL(value).pathname)
      .replace(/\/(token|secret|password|api[_-]?key)\/[^/]+/gi, '/$1/[REDACTED]')
      .replace(/[a-f0-9]{32,}|[A-Za-z0-9_-]{40,}/g, '[REDACTED]')
      .slice(0, 1024);
  } catch { return undefined; }
}

/** Construct new sanitized records. Never retain an original TailItem or unredacted request. */
export function tailEvents(items, { sanitize = redactTelemetry, environment = 'production', now = Date.now() } = {}) {
  if (!Array.isArray(items)) throw new Error('Tail events must be an array');
  const events = [];
  for (const item of items) {
    if (!item || typeof item.scriptName !== 'string' || !item.scriptName || EXCLUDED.has(item.scriptName)) continue;
    const service = item.scriptName.slice(0, 128);
    const received = timestamp(item.eventTimestamp, now);
    const logs = Array.isArray(item.logs) ? item.logs : [];
    const exceptions = Array.isArray(item.exceptions) ? item.exceptions : [];
    const outcome = typeof item.outcome === 'string' ? item.outcome.slice(0, 64) : 'unknown';
    const request = item.event?.request;
    const attrs = { 'deployment.environment.name': environment, 'cf.tail.outcome': outcome, 'cf.tail.logs': logs.length, 'cf.tail.exceptions': exceptions.length, 'cf.tail.omitted_logs': Math.max(0, logs.length - MAX_LOGS), 'cf.tail.omitted_exceptions': Math.max(0, exceptions.length - MAX_EXCEPTIONS) };
    if (typeof request?.method === 'string') attrs['http.method'] = request.method.slice(0, 16);
    const path = pathname(request?.url);
    if (path !== undefined) attrs['http.path'] = path;
    const status = item.event?.response?.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) attrs['http.status_code'] = status;
    const base = { service, timestamp: received, attributes: attrs };
    events.push({ ...base, severity: outcome !== 'ok' || status >= 500 ? 'ERROR' : 'INFO', message: `Worker invocation ${outcome}` });
    for (const log of logs.slice(0, MAX_LOGS)) {
      const parts = Array.isArray(log?.message) ? log.message.slice(0, 20) : [log?.message];
      const text = parts.map(part => message(part, sanitize)).join(' ');
      events.push({ ...base, timestamp: timestamp(log?.timestamp, received), severity: ({ debug: 'DEBUG', info: 'INFO', log: 'INFO', warn: 'WARN', error: 'ERROR' })[log?.level] || 'INFO', message: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} [TRUNCATED]` : text });
    }
    for (const exception of exceptions.slice(0, MAX_EXCEPTIONS)) {
      events.push({ ...base, timestamp: timestamp(exception?.timestamp, received), severity: 'ERROR', message: message(exception?.message ?? 'Unhandled exception', sanitize), attributes: { ...attrs, 'exception.type': message(exception?.name ?? 'Error', sanitize), 'cf.tail.exception': true } });
    }
  }
  return events;
}

export default {
  tail(items, env, ctx) {
    if (!Array.isArray(items)) throw new Error('Tail events must be an array');
    const producers = items.filter(item => item && typeof item.scriptName === 'string' && item.scriptName && !EXCLUDED.has(item.scriptName));
    if (!producers.length) return;
    // One random export ID is reused by the bounded publisher retries. Tail itself has no durable outbox.
    // Process each producer separately so a multi-producer invocation does not exceed the input budget.
    ctx.waitUntil((async () => {
      for (const item of producers) {
        const events = tailEvents([item], { environment: env.ENVIRONMENT || 'production' });
        await publishEvents({ binding: env.OBSERVE, token: env.INGEST_TOKEN, events });
      }
    })());
  }
};
