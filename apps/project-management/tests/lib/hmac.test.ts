import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  signRequest,
  verifyRequest,
} from '~/lib/hmac';

const secret = 'unit-test-secret-32-bytes-long-aaa';

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('signRequest / verifyRequest', () => {
  it('verifies a signature it produced', async () => {
    const ts = 1_700_000_000_000;
    const body = '{"hello":"world"}';
    const sig = await signRequest(secret, body, ts);
    expect(await verifyRequest(secret, body, ts, sig, 5 * 60 * 1000, ts)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = 1_700_000_000_000;
    const sig = await signRequest(secret, 'a', ts);
    expect(await verifyRequest(secret, 'b', ts, sig, 5 * 60 * 1000, ts)).toBe(false);
  });

  it('rejects the wrong secret', async () => {
    const ts = 1_700_000_000_000;
    const sig = await signRequest(secret, 'a', ts);
    expect(await verifyRequest('other-secret', 'a', ts, sig, 5 * 60 * 1000, ts)).toBe(false);
  });

  it('rejects a non-finite timestamp', async () => {
    expect(await verifyRequest(secret, 'a', NaN, 'x')).toBe(false);
  });

  it('rejects timestamps beyond the skew window', async () => {
    const ts = 1_700_000_000_000;
    const sig = await signRequest(secret, 'a', ts);
    expect(await verifyRequest(secret, 'a', ts, sig, 1000, ts + 5000)).toBe(false);
  });

  it('rejects malformed base64 signatures', async () => {
    const ts = 1_700_000_000_000;
    // atob throws on invalid base64 → caught → false.
    expect(await verifyRequest(secret, 'a', ts, '@@@not base64@@@', 5 * 60 * 1000, ts)).toBe(false);
  });
});
