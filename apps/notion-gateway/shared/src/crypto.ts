// Shared crypto helpers.
//
// Two distinct schemes live here:
//
//   * Request signing (HMAC-SHA256):
//     Every consumer-app -> gateway call carries `X-Client-Id`,
//     `X-Timestamp`, and `X-Signature`.  The signature is base64
//     HMAC-SHA256(`${timestamp}\n${body}`) using the client's shared
//     secret stored in `app_clients.hmac_secret`.  We use a fresh
//     timestamp + constant-time compare to defeat replay and timing
//     attacks; `maxSkewMs` rejects anything older than 5 minutes by
//     default.
//
//   * Workspace token encryption (AES-GCM):
//     Notion access tokens land in our database AES-GCM-encrypted with
//     a key derived from the `WORKSPACE_TOKEN_KEY` wrangler secret.  We
//     ship the 12-byte nonce in front of the ciphertext, the whole blob
//     base64-encoded, so a row can be rehydrated without out-of-band
//     metadata.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 helpers ----------

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

// ---------- HMAC request signing ----------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Produce an HMAC-SHA256 signature over `${timestamp}\n${body}`.  The
 * caller stitches `timestamp`/`body` into the request headers + raw body
 * exactly as signed; the gateway re-derives both before verifying.
 */
export async function signRequest(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}\n${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

/**
 * Constant-time signature compare + clock-skew check.  Returns true only
 * when the signature is valid AND `|now - timestamp| <= maxSkewMs`.
 * `maxSkewMs` defaults to 5 minutes to tolerate normal clock drift while
 * still preventing replay of captured requests.
 */
export async function verifyRequest(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
  maxSkewMs = 5 * 60 * 1000,
): Promise<boolean> {
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > maxSkewMs) return false;
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

// ---------- AES-GCM workspace-token encryption ----------

const AES_NONCE_LEN = 12;

/**
 * Derive a 256-bit AES-GCM key from a base64-encoded 32-byte secret.
 * Using SHA-256 over the raw bytes lets us tolerate non-32-byte secrets
 * during dev without weakening production where the secret is exactly
 * 32 bytes.
 */
export async function deriveKey(secret: string): Promise<CryptoKey> {
  let material: Uint8Array;
  try {
    material = base64ToBytes(secret);
  } catch {
    material = enc.encode(secret);
  }
  // Hash to 32 bytes for use as a raw AES key.  Avoids a separate HKDF
  // import step while still tolerating non-32-byte inputs.
  const digest = await crypto.subtle.digest('SHA-256', material as BufferSource);
  return await crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt `plaintext` and return `base64(nonce || ciphertext)`.  Each
 * call uses a fresh 96-bit random nonce — the standard AES-GCM size.
 */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_LEN));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      key,
      enc.encode(plaintext),
    ),
  );
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return bytesToBase64(out);
}

/**
 * Reverse of `encrypt`.  Throws when the ciphertext is malformed or the
 * key doesn't match (AES-GCM's built-in auth tag handles tamper detection).
 */
export async function decrypt(key: CryptoKey, ciphertext: string): Promise<string> {
  const blob = base64ToBytes(ciphertext);
  if (blob.length <= AES_NONCE_LEN) {
    throw new Error('ciphertext too short');
  }
  const nonce = blob.slice(0, AES_NONCE_LEN);
  const cipher = blob.slice(AES_NONCE_LEN);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    cipher as BufferSource,
  );
  return dec.decode(plain);
}

// ---------- Random state helpers ----------

/**
 * Generate a URL-safe random `state` value for the OAuth dance.  32
 * bytes of entropy, base64url-encoded — fits well under URL-length
 * limits and is opaque enough that an attacker can't guess pending
 * states.
 */
export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
