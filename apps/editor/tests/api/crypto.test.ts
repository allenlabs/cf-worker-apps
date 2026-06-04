// Unit tests for the at-rest secret encryption used by per-workspace AI
// settings. Uses the real Web Crypto AES-GCM (global in Node 20+), so this
// proves the actual round-trip — not a stub.

import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '@api/lib/crypto';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret under the same key', async () => {
    const key = 'server-side-AI_SETTINGS_KEY';
    const plaintext = 'sk-super-secret-api-key';
    const { cipher, iv } = await encryptSecret(key, plaintext);
    // The ciphertext must NOT be the plaintext (encrypted at rest).
    expect(cipher).not.toContain(plaintext);
    expect(typeof iv).toBe('string');
    const out = await decryptSecret(key, cipher, iv);
    expect(out).toBe(plaintext);
  });

  it('produces a fresh IV (and thus different ciphertext) each call', async () => {
    const key = 'k';
    const a = await encryptSecret(key, 'same');
    const b = await encryptSecret(key, 'same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
    // …yet both decrypt back to the same plaintext.
    expect(await decryptSecret(key, a.cipher, a.iv)).toBe('same');
    expect(await decryptSecret(key, b.cipher, b.iv)).toBe('same');
  });

  it('fails to decrypt with the wrong key (auth tag mismatch)', async () => {
    const { cipher, iv } = await encryptSecret('right-key', 'value');
    await expect(decryptSecret('wrong-key', cipher, iv)).rejects.toBeDefined();
  });

  it('handles unicode + empty strings', async () => {
    const key = 'k';
    for (const v of ['', '한국어 키 🔑', 'a'.repeat(300)]) {
      const { cipher, iv } = await encryptSecret(key, v);
      expect(await decryptSecret(key, cipher, iv)).toBe(v);
    }
  });
});
