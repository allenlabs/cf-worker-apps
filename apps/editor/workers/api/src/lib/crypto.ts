// At-rest secret encryption for workspace AI settings (the API key a workspace
// owner sets when pointing the AI assist route at a custom OpenAI-compatible
// provider). Uses Web Crypto AES-GCM (available on the Workers runtime + Node
// 20+ globalThis.crypto), so there's no dependency and it's unit-testable.
//
// The encryption key is the server secret AI_SETTINGS_KEY (set via
// `wrangler secret put`). We derive a 256-bit AES key from it with SHA-256 so
// any reasonable-length secret works. A fresh random 12-byte IV is generated
// per encryption and stored alongside the ciphertext; both are base64-encoded
// for text storage in Postgres.
//
// Pure (no Cloudflare/Hono coupling) — the handlers inject encrypt/decrypt as
// deps so tests can stub them, and so the round-trip is provable in isolation.

/** Base64-encode raw bytes (runtime-agnostic: btoa on Workers, Buffer on Node). */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode a base64 string back to bytes. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derive a 256-bit AES-GCM key from an arbitrary-length server secret. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedSecret {
  /** base64 AES-GCM ciphertext (includes the auth tag). */
  cipher: string;
  /** base64 12-byte IV used for this encryption. */
  iv: string;
}

/**
 * Encrypt `plaintext` with AES-GCM under a key derived from `key`. Returns the
 * base64 ciphertext + the base64 IV (store both; the IV is not secret).
 */
export async function encryptSecret(key: string, plaintext: string): Promise<EncryptedSecret> {
  const cryptoKey = await deriveKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    enc.encode(plaintext),
  );
  return { cipher: toBase64(new Uint8Array(buf)), iv: toBase64(iv) };
}

/**
 * Decrypt a base64 AES-GCM ciphertext + IV produced by `encryptSecret` under
 * the same `key`. Throws if the key/IV/ciphertext don't match (tamper/wrong key).
 */
export async function decryptSecret(key: string, cipher: string, iv: string): Promise<string> {
  const cryptoKey = await deriveKey(key);
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    cryptoKey,
    fromBase64(cipher),
  );
  return new TextDecoder().decode(buf);
}
