// HMAC-signing client for the editor-api backend.
//
// SIMPLIFIED scheme (single shared secret, mirrors the api worker's verify):
//   X-Timestamp   ms-since-epoch
//   X-Signature   base64( HMAC-SHA256( `${ts}\n${body}`, EDITOR_HMAC_SECRET ) )
//
// Every call is POST with a JSON body (keeps signing uniform). Lives under
// app/lib so the secret stays server-side (only imported from *.server.* code).

const enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export async function signBody(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}\n${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

export interface ApiClientEnv {
  EDITOR_API_URL: string;
  EDITOR_HMAC_SECRET: string;
}

export interface ApiClientDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

/**
 * Sign + POST a JSON body to `editor-api`. Throws an Error (status + truncated
 * body) on non-2xx so server fns can surface a useful message.
 */
export async function apiPostImpl<T>(
  env: ApiClientEnv,
  path: string,
  body: Record<string, unknown>,
  deps: ApiClientDeps = {},
): Promise<T> {
  const ts = (deps.now ?? Date.now)();
  const raw = JSON.stringify(body ?? {});
  const sig = await signBody(env.EDITOR_HMAC_SECRET, ts, raw);
  const base = env.EDITOR_API_URL.replace(/\/$/, '');
  /* v8 ignore next — real fetch is the production default; tests inject one. */
  const fetcher = deps.fetcher ?? fetch;
  const res = await fetcher(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': String(ts),
      'X-Signature': sig,
    },
    body: raw,
  });
  if (!res.ok) {
    /* v8 ignore next — res.text() only rejects on malformed bodies. */
    const text = await res.text().catch(() => '');
    throw new Error(`editor-api ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
