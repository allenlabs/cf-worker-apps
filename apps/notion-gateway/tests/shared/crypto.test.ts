import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decrypt,
  deriveKey,
  encrypt,
  randomState,
  signRequest,
  verifyRequest,
} from '@shared/crypto';

describe('base64 round-trip', () => {
  it('encodes + decodes correctly', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 200, 0]);
    const b64 = bytesToBase64(bytes);
    const back = base64ToBytes(b64);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe('signRequest + verifyRequest', () => {
  it('verifies a valid signature', async () => {
    const secret = 'super-secret';
    const body = '{"hello":"world"}';
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    expect(await verifyRequest(secret, body, ts, sig)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const secret = 'super-secret';
    const ts = Date.now();
    const sig = await signRequest(secret, '{"a":1}', ts);
    expect(await verifyRequest(secret, '{"a":2}', ts, sig)).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const ts = Date.now();
    const sig = await signRequest('s1', 'body', ts);
    expect(await verifyRequest('s2', 'body', ts, sig)).toBe(false);
  });

  it('rejects an expired timestamp', async () => {
    const secret = 's';
    const ts = Date.now() - 10 * 60 * 1000;
    const sig = await signRequest(secret, 'body', ts);
    expect(await verifyRequest(secret, 'body', ts, sig)).toBe(false);
  });

  it('rejects a non-finite timestamp', async () => {
    expect(await verifyRequest('s', 'body', Number.NaN, 'sig')).toBe(false);
  });

  it('rejects a malformed signature', async () => {
    const ts = Date.now();
    expect(await verifyRequest('s', 'body', ts, '!!!not-base64!!!')).toBe(false);
  });

  it('honors a custom skew window', async () => {
    const secret = 's';
    const ts = Date.now() - 30 * 1000;
    const sig = await signRequest(secret, 'body', ts);
    expect(await verifyRequest(secret, 'body', ts, sig, 10 * 1000)).toBe(false);
    expect(await verifyRequest(secret, 'body', ts, sig, 60 * 1000)).toBe(true);
  });
});

describe('encrypt + decrypt', () => {
  it('round-trips via a base64 secret', async () => {
    const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const key = await deriveKey(secret);
    const ct = await encrypt(key, 'hello notion');
    expect(ct).not.toBe('hello notion');
    expect(await decrypt(key, ct)).toBe('hello notion');
  });

  it('round-trips via a raw-string secret (dev fallback)', async () => {
    const key = await deriveKey('not-base64-at-all!!!');
    const ct = await encrypt(key, 'payload');
    expect(await decrypt(key, ct)).toBe('payload');
  });

  it('uses a fresh nonce each call', async () => {
    const key = await deriveKey('test');
    const a = await encrypt(key, 'same');
    const b = await encrypt(key, 'same');
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt a truncated ciphertext', async () => {
    const key = await deriveKey('test');
    await expect(decrypt(key, bytesToBase64(new Uint8Array(5)))).rejects.toThrow(/too short/);
  });

  it('refuses to decrypt with a wrong key', async () => {
    const ct = await encrypt(await deriveKey('a'), 'secret');
    await expect(decrypt(await deriveKey('b'), ct)).rejects.toThrow();
  });
});

describe('randomState', () => {
  it('returns a URL-safe high-entropy string', () => {
    const a = randomState();
    const b = randomState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(30);
  });
});
