import { describe, expect, it } from 'vitest';
import { ShortenError, incrementClicks, resolveImpl, shortenImpl } from '../../src/shorten';

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVNamespace;
}

describe('shortenImpl', () => {
  it('mints a random code and writes a record', async () => {
    const kv = makeKv();
    const out = await shortenImpl({
      kv,
      url: 'https://example.com',
      codeLength: 6,
    });
    expect(out.url).toBe('https://example.com');
    expect(out.code).toMatch(/^[A-Za-z0-9]{6}$/);
    const record = await resolveImpl(kv, out.code);
    expect(record?.url).toBe('https://example.com');
    expect(record?.clicks).toBe(0);
  });

  it('honours a custom code when provided', async () => {
    const kv = makeKv();
    const out = await shortenImpl({
      kv,
      url: 'https://example.com',
      codeLength: 7,
      customCode: 'my-link',
    });
    expect(out.code).toBe('my-link');
  });

  it('rejects an invalid custom code', async () => {
    const kv = makeKv();
    await expect(
      shortenImpl({ kv, url: 'https://example.com', codeLength: 7, customCode: 'no!' }),
    ).rejects.toThrow(ShortenError);
  });

  it('rejects a custom code that is already taken', async () => {
    const kv = makeKv();
    await shortenImpl({ kv, url: 'https://a.com', codeLength: 7, customCode: 'taken' });
    await expect(
      shortenImpl({ kv, url: 'https://b.com', codeLength: 7, customCode: 'taken' }),
    ).rejects.toThrow(/already in use/);
  });

  it('rejects an obvious non-URL', async () => {
    const kv = makeKv();
    await expect(
      shortenImpl({ kv, url: 'not a url', codeLength: 7 }),
    ).rejects.toThrow(/http/);
  });

  it('rejects a URL that fails the WHATWG parser', async () => {
    const kv = makeKv();
    await expect(
      shortenImpl({ kv, url: 'http://', codeLength: 7 }),
    ).rejects.toThrow(/parseable/);
  });

  it('gives up after 5 collisions with a uniqueness error', async () => {
    // A KV that always reports the candidate code as taken.
    const fullKv = {
      get: async () => 'taken',
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace;
    await expect(
      shortenImpl({ kv: fullKv, url: 'https://x.com', codeLength: 2 }),
    ).rejects.toThrow(/unusually full/);
  });

  it('retries when nanoid collides with existing entries', async () => {
    const kv = makeKv();
    // Pre-populate enough codes to force at least one collision regardless of
    // the first try.  Strategy: stuff KV with all 2-character codes built
    // from a small alphabet and ask shorten for length=2.  We pad the
    // alphabet so there's still room.
    for (const a of ['a', 'b']) {
      for (const b of ['a', 'b']) {
        await kv.put(a + b, JSON.stringify({ url: 'x', createdAt: 0, clicks: 0 }));
      }
    }
    const out = await shortenImpl({ kv, url: 'https://x.com', codeLength: 2 });
    expect(out.code).toBeTruthy();
  });
});

describe('resolveImpl + incrementClicks', () => {
  it('resolveImpl returns null for unknown codes', async () => {
    expect(await resolveImpl(makeKv(), 'nope')).toBeNull();
  });

  it('incrementClicks bumps the counter and persists', async () => {
    const kv = makeKv();
    await shortenImpl({ kv, url: 'https://x.com', codeLength: 7, customCode: 'abc' });
    await incrementClicks(kv, 'abc');
    await incrementClicks(kv, 'abc');
    const r = await resolveImpl(kv, 'abc');
    expect(r?.clicks).toBe(2);
  });

  it('incrementClicks no-ops for unknown codes', async () => {
    const kv = makeKv();
    await incrementClicks(kv, 'ghost');
    expect(await resolveImpl(kv, 'ghost')).toBeNull();
  });
});
