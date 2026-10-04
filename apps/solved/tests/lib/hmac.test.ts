import { describe, it, expect } from 'vitest';
import {
  signRequest,
  verifyRequest,
  bytesToBase64,
  base64ToBytes,
} from '~/lib/hmac';

const SECRET = 'test-secret-32-bytes-long-aaaaaaa';

describe('signRequest + verifyRequest', () => {
  it('signs and verifies', async () => {
    const ts = Date.now();
    const body = '{"hello":"world"}';
    const sig = await signRequest(SECRET, body, ts);
    expect(await verifyRequest(SECRET, body, ts, sig)).toBe(true);
  });

  it('fails on mutated body', async () => {
    const ts = Date.now();
    const sig = await signRequest(SECRET, 'a', ts);
    expect(await verifyRequest(SECRET, 'b', ts, sig)).toBe(false);
  });

  it('rejects stale ts beyond skew', async () => {
    const ts = Date.now();
    const sig = await signRequest(SECRET, '', ts);
    expect(await verifyRequest(SECRET, '', ts, sig, 1, ts + 1000)).toBe(false);
  });

  it('rejects non-finite ts', async () => {
    expect(await verifyRequest(SECRET, '', Number.NaN, 'x')).toBe(false);
  });

  it('rejects invalid base64 signature', async () => {
    const ts = Date.now();
    expect(await verifyRequest(SECRET, '', ts, '!!!not-base64')).toBe(false);
  });
});

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
