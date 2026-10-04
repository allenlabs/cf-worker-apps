import { describe, expect, it } from 'vitest';
import { signRequest, verifyRequest, bytesToBase64, base64ToBytes } from '~/lib/hmac';

describe('signRequest / verifyRequest', () => {
  it('round-trips a signature', async () => {
    const ts = Date.now();
    const body = JSON.stringify({ body: 'curl -X POST', tags: ['curl'] });
    const sig = await signRequest('s3cr3t', body, ts);
    expect(await verifyRequest('s3cr3t', body, ts, sig)).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const ts = Date.now();
    const sig = await signRequest('right', 'body', ts);
    expect(await verifyRequest('wrong', 'body', ts, sig)).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const ts = Date.now();
    const sig = await signRequest('s', 'body', ts);
    expect(await verifyRequest('s', 'body-modified', ts, sig)).toBe(false);
  });

  it('rejects a non-finite timestamp', async () => {
    expect(await verifyRequest('s', 'b', Number.NaN, 'AAAA')).toBe(false);
  });

  it('rejects a stale timestamp (> 5 min skew)', async () => {
    const ts = Date.now() - 10 * 60 * 1000;
    const sig = await signRequest('s', 'b', ts);
    expect(await verifyRequest('s', 'b', ts, sig)).toBe(false);
  });

  it('rejects a non-base64 signature', async () => {
    const ts = Date.now();
    expect(await verifyRequest('s', 'b', ts, '!!!not-base64!!!')).toBe(false);
  });

  it('accepts a pinned "now" for deterministic tests', async () => {
    const ts = 1_700_000_000_000;
    const sig = await signRequest('s', 'b', ts);
    expect(await verifyRequest('s', 'b', ts, sig, undefined, ts + 1000)).toBe(true);
    expect(await verifyRequest('s', 'b', ts, sig, undefined, ts + 6 * 60 * 1000)).toBe(false);
  });
});

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 2, 250, 255]);
  });
});
