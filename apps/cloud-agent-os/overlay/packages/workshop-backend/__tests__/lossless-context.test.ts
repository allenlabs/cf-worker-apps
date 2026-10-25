import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { archiveText, readTextArtifact, type LosslessTextStore } from '../src/lossless-context';
import './test-worker';

let count = 0;
const encoder = new TextEncoder();

function sqlStore(storage: DurableObjectStorage): LosslessTextStore {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS lossless_text_fixture (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    get(key) {
      const row = storage.sql.exec<{ value: string }>('SELECT value FROM lossless_text_fixture WHERE key = ?', key).toArray()[0];
      return row ? JSON.parse(row.value) : undefined;
    },
    put(key, value) {
      storage.sql.exec('INSERT OR REPLACE INTO lossless_text_fixture (key, value) VALUES (?, ?)', key, JSON.stringify(value));
    },
    transaction(callback) { return storage.transactionSync(callback); },
  };
}

async function inStore(test: (store: LosslessTextStore, storage: DurableObjectStorage) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`lossless-context-${++count}`), async instance => {
    const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
    await test(sqlStore(storage), storage);
  });
}

describe('lossless context archive', () => {
  it('commits required metadata atomically with content, including a deduplicated write', () => inStore(async (store, storage) => {
    await expect(archiveText(store, 1, 'protected original', reference => {
      store.put(`policy:${reference.id}`, ['plugin']);
      throw new Error('Policy write failed');
    })).rejects.toThrow('Policy write failed');
    expect(storage.sql.exec('SELECT * FROM lossless_text_fixture').toArray()).toEqual([]);
    const reference = await archiveText(store, 1, 'protected original');
    await archiveText(store, 1, 'protected original', repeated => store.put(`policy:${repeated.id}`, ['plugin']));
    expect(store.get(`policy:${reference.id}`)).toEqual(['plugin']);
  }));

  it('round trips a long Unicode record through complete bounded JSON pages after reopening storage', () => inStore(async (store, storage) => {
    // A surrogate pair straddles the first chunk's nominal byte boundary; the body also
    // exercises JSON escaping, whose wire cost is larger than its UTF-8 text cost.
    const text = 'a'.repeat(32767) + '🧭' + JSON.stringify({ original: ('한글🧭\n\u0000"\\').repeat(7000) });
    const ref = await archiveText(store, 7, text);
    expect(ref.chars).toBe(text.length);
    expect(ref.bytes).toBe(encoder.encode(text).byteLength);
    const restored = sqlStore(storage);
    let cursor: string | null = ref.startCursor;
    let full = '';
    let pages = 0;
    while (cursor !== null) {
      const page = await readTextArtifact(restored, 7, ref.id, { cursor });
      const serialized = JSON.stringify(page);
      expect(encoder.encode(serialized).byteLength).toBeLessThanOrEqual(8192);
      expect(JSON.parse(serialized)).toEqual(page);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(page.content))).toBe(page.content);
      expect(page.start).toBe(full.length);
      expect(page.end).toBe(page.start + page.content.length);
      expect(page.eof).toBe(page.nextCursor === null);
      if (!page.eof) expect(page.end).toBeGreaterThan(page.start);
      full += page.content;
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(1000);
    }
    expect(full).toBe(text);
    expect(pages).toBeGreaterThan(2);
    const chunks = storage.sql.exec<{ value: string }>("SELECT value FROM lossless_text_fixture WHERE key LIKE '%:chunk:%'").toArray();
    expect(chunks.length).toBeGreaterThan(2);
    for (const { value } of chunks) expect(encoder.encode(JSON.parse(value)).byteLength).toBeLessThanOrEqual(32768);
  }));

  it('content addresses exact UTF-8 text and deduplicates within the same chat', () => inStore(async (store, storage) => {
    const first = await archiveText(store, 9, 'abc');
    expect(first.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const before = storage.sql.exec('SELECT * FROM lossless_text_fixture ORDER BY key').toArray();
    expect(await archiveText(sqlStore(storage), 9, 'abc')).toEqual(first);
    expect(storage.sql.exec('SELECT * FROM lossless_text_fixture ORDER BY key').toArray()).toEqual(before);
    await expect(readTextArtifact(store, 10, first.id)).rejects.toThrow(/not found/);
    const other = await archiveText(store, 10, 'abc');
    await expect(readTextArtifact(store, 10, other.id, { cursor: first.startCursor })).rejects.toThrow(/cursor/i);
    expect((await readTextArtifact(store, 9, first.id)).content).toBe('abc');
  }));

  it('bounds serialized chunk storage even when control characters expand sixfold in JSON', () => inStore(async (store, storage) => {
    const text = '\u0000'.repeat(40_000);
    const ref = await archiveText(store, 1, text);
    const chunks = storage.sql.exec<{ value: string }>("SELECT value FROM lossless_text_fixture WHERE key LIKE '%:chunk:%'").toArray();
    for (const { value } of chunks) expect(encoder.encode(value).byteLength).toBeLessThanOrEqual(32768);
    const first = await readTextArtifact(store, 1, ref.id);
    expect(first.content).toBe('\u0000'.repeat(first.content.length));
  }));

  it('pages one large JSON value as text without requiring partial JSON parsing', () => inStore(async store => {
    const text = JSON.stringify({ value: '"\n\u0000🧭'.repeat(3000) });
    const ref = await archiveText(store, 1, text);
    let cursor: string | null = ref.startCursor;
    let full = '';
    while (cursor !== null) {
      const page = await readTextArtifact(store, 1, ref.id, { cursor, maxBytes: 1024 });
      expect(encoder.encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(1024);
      full += JSON.parse(JSON.stringify(page)).content;
      cursor = page.nextCursor;
    }
    expect(JSON.parse(full)).toEqual({ value: '"\n\u0000🧭'.repeat(3000) });
  }));

  it('returns an explicit terminal page for an empty artifact', () => inStore(async store => {
    const ref = await archiveText(store, 1, '');
    const page = await readTextArtifact(store, 1, ref.id, { cursor: ref.startCursor });
    expect(page).toMatchObject({ content: '', start: 0, end: 0, totalChars: 0, totalBytes: 0, eof: true, nextCursor: null });
  }));

  it('rejects malformed, cross-artifact, out-of-range, and split-surrogate cursors', () => inStore(async store => {
    const ref = await archiveText(store, 1, 'x🧭y');
    const other = await archiveText(store, 1, 'different');
    await expect(readTextArtifact(store, 1, ref.id, { cursor: other.startCursor })).rejects.toThrow(/cursor/i);
    await expect(readTextArtifact(store, 1, ref.id, { cursor: 'invalid' })).rejects.toThrow(/cursor/i);
    for (const offset of [-1, 0.5, 2, 99]) {
      const cursor = JSON.stringify({ ...JSON.parse(ref.startCursor), offset });
      await expect(readTextArtifact(store, 1, ref.id, { cursor })).rejects.toThrow(/cursor/i);
    }
    for (const maxBytes of [0, 100, 1024.5, NaN, 8193]) {
      await expect(readTextArtifact(store, 1, ref.id, { maxBytes })).rejects.toThrow(/page.*limit/i);
    }
  }));

  it.each(['missing', 'corrupt'] as const)('refuses %s chunks instead of returning a shortened success', mode => inStore(async (store, storage) => {
    const ref = await archiveText(store, 1, 'original text');
    const key = storage.sql.exec<{ key: string }>("SELECT key FROM lossless_text_fixture WHERE key LIKE '%:chunk:%'").toArray()[0].key;
    if (mode === 'missing') storage.sql.exec('DELETE FROM lossless_text_fixture WHERE key = ?', key);
    else store.put(key, 'corrupt! text');
    await expect(readTextArtifact(store, 1, ref.id)).rejects.toThrow(/missing|corrupt|integrity/i);
    await expect(archiveText(store, 1, 'original text')).rejects.toThrow(/missing|corrupt|integrity/i);
  }));

  it('rolls back the entire artifact if a chunk write fails', () => inStore(async (store, storage) => {
    await archiveText(store, 2, 'unrelated original');
    const before = storage.sql.exec('SELECT * FROM lossless_text_fixture ORDER BY key').toArray();
    let puts = 0;
    const failing: LosslessTextStore = { ...store, put(key, value) {
      store.put(key, value);
      if (++puts === 2) throw new Error('Synthetic storage failure');
    } };
    await expect(archiveText(failing, 1, 'x'.repeat(100_000))).rejects.toThrow('Synthetic storage failure');
    expect(storage.sql.exec('SELECT * FROM lossless_text_fixture ORDER BY key').toArray()).toEqual(before);
  }));

  it('rejects unpaired surrogates without writing a normalized replacement', () => inStore(async (store, storage) => {
    for (const text of ['\ud800', '\udc00', 'before\ud800after']) {
      await expect(archiveText(store, 1, text)).rejects.toThrow(/Unicode/);
    }
    expect(storage.sql.exec('SELECT * FROM lossless_text_fixture').toArray()).toEqual([]);
  }));
});
