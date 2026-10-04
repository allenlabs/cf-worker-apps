import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, signRequest, verifyRequest } from '~/lib/hmac';

describe('HMAC helpers', () => {
  it('round-trips sign + verify', async () => {
    const sig = await signRequest('secret', 'body', 1000);
    expect(await verifyRequest('secret', 'body', 1000, sig, undefined, 1000)).toBe(true);
  });
  it('fails verify with wrong secret', async () => {
    const sig = await signRequest('secret', 'body', 1000);
    expect(await verifyRequest('wrong', 'body', 1000, sig, undefined, 1000)).toBe(false);
  });
  it('fails verify with stale timestamp', async () => {
    const sig = await signRequest('secret', 'body', 1000);
    expect(await verifyRequest('secret', 'body', 1000, sig, undefined, 1000 + 10 * 60 * 1000)).toBe(false);
  });
  it('fails verify with non-finite timestamp', async () => {
    const sig = await signRequest('secret', 'body', 1000);
    expect(await verifyRequest('secret', 'body', NaN, sig)).toBe(false);
  });
  it('fails verify with malformed signature', async () => {
    expect(await verifyRequest('secret', 'body', 1000, '!!!', undefined, 1000)).toBe(false);
  });
  it('round-trips base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
