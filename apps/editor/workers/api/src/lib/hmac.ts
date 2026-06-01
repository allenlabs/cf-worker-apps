// HMAC helpers for the editor API worker.
//
// SIMPLIFIED vs inbox: a single shared secret (EDITOR_HMAC_SECRET) on both the
// web worker (signs) and the api worker (verifies) — no api_clients table.
//
// Scheme (every /v1/* request, all POST with a JSON body):
//   X-Timestamp   ms-since-epoch as a Number string
//   X-Signature   base64( HMAC-SHA256( `${timestamp}\n${body}`, secret ) )
//
// Tolerates 5 min clock skew; constant-time compare via WebCrypto.subtle.

const enc = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

export async function signRequest(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}\n${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyRequest(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
  maxSkewMs = 5 * 60 * 1000,
  now: number = Date.now(),
): Promise<boolean> {
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > maxSkewMs) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature);
  } catch {
    return false;
  }
  const key = await hmacKey(secret, ['verify']);
  return await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    enc.encode(`${timestamp}\n${body}`),
  );
}

/** base64 → base64url: +→-, /→_, '=' padding stripped. */
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url-encode a UTF-8 string. */
export function base64urlString(input: string): string {
  // btoa needs a binary string; encode UTF-8 → latin1-safe bytes first.
  const bytes = enc.encode(input);
  return toBase64Url(bytesToBase64(bytes));
}

/** base64url-encode raw bytes. */
export function base64urlBytes(bytes: Uint8Array): string {
  return toBase64Url(bytesToBase64(bytes));
}

/**
 * Mint a room-scoped collab token the allenlabs-collab worker will verify:
 *   payloadPart = b64url(JSON(payload))
 *   token       = payloadPart + "." + b64url(HMAC_SHA256(secret, payloadPart))
 *
 * IMPORTANT: the MAC is over the BASE64URL-encoded payload string, NOT the raw
 * JSON. The collab worker verifies `HMAC(secret, payloadPart)` against the
 * b64url-decoded signature (confirmed empirically — raw-JSON MAC is rejected
 * with 401). Keep these two in lockstep.
 */
export async function mintCollabToken(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const payloadPart = base64urlString(JSON.stringify(payload));
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadPart));
  return `${payloadPart}.${base64urlBytes(new Uint8Array(sig))}`;
}
