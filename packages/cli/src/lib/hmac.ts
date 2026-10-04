// HMAC signed-fetch helper.  Mirrors the inbox-api scheme:
//
//   X-Client-Id   the configured client_id
//   X-Timestamp   Date.now() as a string (ms)
//   X-Signature   base64 HMAC-SHA256(secret, `${ts}\n${body}`)
//
// All apps in the suite share this contract, so signedFetch works for
// inbox, focus, and any future siblings.

import { createHmac } from 'node:crypto';

export interface SignedRequestHeaders extends Record<string, string> {
  'X-Client-Id': string;
  'X-Timestamp': string;
  'X-Signature': string;
  'Content-Type': string;
}

export function signBody(secret: string, body: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('base64');
}

export function buildHeaders(
  clientId: string,
  secret: string,
  body: string,
  timestamp: number = Date.now(),
): SignedRequestHeaders {
  return {
    'X-Client-Id': clientId,
    'X-Timestamp': String(timestamp),
    'X-Signature': signBody(secret, body, timestamp),
    'Content-Type': 'application/json',
  };
}

export interface AppEndpoint {
  url: string;
  client_id: string;
  secret: string;
}

export interface SignedFetchResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

/** Join a base URL and a path without double-slashing. */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export interface SignedFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  now?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function signedFetch<T = unknown>(
  endpoint: AppEndpoint,
  path: string,
  options: SignedFetchOptions = {},
): Promise<SignedFetchResult<T>> {
  const method = options.method ?? 'POST';
  // GET requests sign an empty body — same as the API expects.
  const bodyStr = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers = buildHeaders(endpoint.client_id, endpoint.secret, bodyStr, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (method !== 'GET' && options.body !== undefined) {
      init.body = bodyStr;
    }
    const res = await fetchImpl(joinUrl(endpoint.url, path), init);
    const text = await res.text();
    let data: T | null = null;
    let error: string | null = null;
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (res.ok) {
          data = parsed as T;
        } else {
          // API returns { error: '...' } on failure.
          const maybe = parsed as { error?: unknown } | null;
          error = maybe && typeof maybe.error === 'string' ? maybe.error : text;
        }
      } catch {
        if (res.ok) {
          // Non-JSON 2xx — surface as text in `data`.
          data = text as unknown as T;
        } else {
          error = text;
        }
      }
    } else if (!res.ok) {
      error = `HTTP ${res.status}`;
    }
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Unsigned GET — used by `al config` to ping /health. */
export async function pingHealth(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const res = await fetchImpl(joinUrl(url, '/health'), { method: 'GET', signal: controller.signal });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
