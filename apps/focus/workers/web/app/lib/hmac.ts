// HMAC helpers — verbatim port of inbox's lib/hmac.ts.  Shared between the
// API worker (verifies inbound) and any tooling we add to sign requests
// (CLI, browser ext).
//
// Scheme:
//   X-Client-Id   client_id, e.g. 'cli'
//   X-Timestamp   ms-since-epoch as a Number string
//   X-Signature   base64 HMAC-SHA256(`${timestamp}\n${body}`, hmac_secret)
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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signRequest(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const key = await hmacKey(secret);
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
  const key = await hmacKey(secret);
  return await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    enc.encode(`${timestamp}\n${body}`),
  );
}
