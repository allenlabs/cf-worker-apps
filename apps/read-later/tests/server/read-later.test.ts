import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  deleteItemImpl,
  findApiClientImpl,
  getItemImpl,
  issueApiClientImpl,
  issueApiClientSchema,
  listApiClientsImpl,
  listItemsImpl,
  loadQueueImpl,
  markDoneImpl,
  nextItemImpl,
  saveItemImpl,
  saveSchema,
  skipItemImpl,
} from '~/server/read-later';
import { findUserBySsoImpl } from '~/server/users';

// ---------- schemas ----------

describe('saveSchema', () => {
  it('rejects missing url', () => {
    expect(saveSchema.safeParse({}).success).toBe(false);
  });
  it('rejects an invalid url', () => {
    expect(saveSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });
  it('rejects an empty title', () => {
    expect(saveSchema.safeParse({ url: 'https://x.com', title: '' }).success).toBe(false);
  });
  it('rejects too many tags', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    expect(saveSchema.safeParse({ url: 'https://x.com', tags }).success).toBe(false);
  });
  it('accepts a minimal valid input', () => {
    expect(saveSchema.safeParse({ url: 'https://x.com' }).success).toBe(true);
  });
  it('accepts all optional fields', () => {
    const r = saveSchema.safeParse({
      url: 'https://x.com',
      title: 'hi',
      tags: ['a', 'b'],
      source: 'cli',
    });
    expect(r.success).toBe(true);
  });
  it('rejects unknown source', () => {
    expect(
      saveSchema.safeParse({ url: 'https://x.com', source: 'bogus' }).success,
    ).toBe(false);
  });
});

// ---------- saveItemImpl ----------

describe('saveItemImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a bare URL when no deps provided', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await saveItemImpl(db, userId, { url: 'https://example.com/x' }, now);
    expect(r.url).toBe('https://example.com/x');
    expect(r.title).toBeNull();
    expect(r.estimatedMinutes).toBeNull();
    expect(r.savedAt.toISOString()).toBe(now.toISOString());
  });

  it('uses the supplied title over any extracted one', async () => {
    const r = await saveItemImpl(
      db,
      userId,
      { url: 'https://example.com', title: 'My Title' },
      undefined,
      {
        fetch: (async () =>
          new Response('<html><head><title>Other</title></head><body></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof globalThis.fetch,
      },
    );
    expect(r.title).toBe('My Title');
  });

  it('persists tags', async () => {
    const r = await saveItemImpl(db, userId, {
      url: 'https://example.com',
      tags: ['rust', 'systems'],
    });
    const rows = (await db.execute(
      sql`SELECT tags FROM read_later.items WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { tags: string[] }).tags).toEqual(['rust', 'systems']);
  });

  it('persists source', async () => {
    const r = await saveItemImpl(db, userId, {
      url: 'https://example.com',
      source: 'cli',
    });
    const rows = (await db.execute(
      sql`SELECT source FROM read_later.items WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { source: string }).source).toBe('cli');
  });

  it('falls through to a bare save when extraction returns empty', async () => {
    const r = await saveItemImpl(
      db,
      userId,
      { url: 'https://example.com' },
      undefined,
      {
        fetch: (async () =>
          new Response('', { status: 500 })) as unknown as typeof globalThis.fetch,
      },
    );
    expect(r.url).toBe('https://example.com');
    expect(r.title).toBeNull();
    expect(r.estimatedMinutes).toBeNull();
  });

  it('extracts title + word_count + estimated_minutes via Readability', async () => {
    const longBody = 'word '.repeat(500);
    const html = `<html><head><title>X</title></head><body><article><h1>Headline</h1><p>${longBody}</p></article></body></html>`;
    const r = await saveItemImpl(
      db,
      userId,
      { url: 'https://example.com' },
      undefined,
      {
        fetch: (async () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch,
      },
    );
    expect(r.estimatedMinutes).toBeGreaterThanOrEqual(1);
  });
});

// ---------- nextItemImpl ----------

describe('nextItemImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    userId = (await insertPmUser(db, { login: 'alice' })).id;
  });

  it('returns null when nothing is queued', async () => {
    expect(await nextItemImpl(db, userId)).toBeNull();
  });

  it('returns the oldest unread when no freeMinutes given', async () => {
    await saveItemImpl(db, userId, { url: 'https://a' }, new Date('2026-05-24T09:00:00Z'));
    await saveItemImpl(db, userId, { url: 'https://b' }, new Date('2026-05-24T09:01:00Z'));
    const r = await nextItemImpl(db, userId);
    expect(r?.url).toBe('https://a');
  });

  it('prefers items that fit in freeMinutes', async () => {
    // Long one, saved earlier:
    const long = await saveItemImpl(db, userId, { url: 'https://long' }, new Date('2026-05-24T09:00:00Z'));
    await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 30 WHERE id = ${long.id}`);
    // Short one, saved later:
    const short = await saveItemImpl(db, userId, { url: 'https://short' }, new Date('2026-05-24T09:05:00Z'));
    await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 5 WHERE id = ${short.id}`);

    const r = await nextItemImpl(db, userId, 10);
    expect(r?.url).toBe('https://short');
  });

  it('sinks skipped items below fresh ones', async () => {
    const skipped = await saveItemImpl(db, userId, { url: 'https://skipped' }, new Date('2026-05-24T09:00:00Z'));
    await db.execute(
      sql`UPDATE read_later.items SET skipped_count = 3 WHERE id = ${skipped.id}`,
    );
    await saveItemImpl(db, userId, { url: 'https://fresh' }, new Date('2026-05-24T10:00:00Z'));
    const r = await nextItemImpl(db, userId);
    expect(r?.url).toBe('https://fresh');
  });

  it('ignores read items', async () => {
    const a = await saveItemImpl(db, userId, { url: 'https://done' });
    await markDoneImpl(db, userId, a.id);
    await saveItemImpl(db, userId, { url: 'https://still-here' });
    const r = await nextItemImpl(db, userId);
    expect(r?.url).toBe('https://still-here');
  });

  it('ignores other users\' items', async () => {
    const other = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    await saveItemImpl(db, other.id, { url: 'https://bob' });
    expect(await nextItemImpl(db, userId)).toBeNull();
  });

  it('rejects non-finite freeMinutes by falling back to plain ordering', async () => {
    await saveItemImpl(db, userId, { url: 'https://a' });
    expect((await nextItemImpl(db, userId, NaN))?.url).toBe('https://a');
    expect((await nextItemImpl(db, userId, 0))?.url).toBe('https://a');
    expect((await nextItemImpl(db, userId, null))?.url).toBe('https://a');
  });
});

// ---------- listItemsImpl ----------

describe('listItemsImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    userId = (await insertPmUser(db, { login: 'alice' })).id;
  });

  it('returns [] when empty', async () => {
    expect(await listItemsImpl(db, userId)).toEqual({ items: [], total: 0 });
  });

  it('only shows unread by default', async () => {
    const a = await saveItemImpl(db, userId, { url: 'https://a' });
    await markDoneImpl(db, userId, a.id);
    await saveItemImpl(db, userId, { url: 'https://b' });
    const r = await listItemsImpl(db, userId);
    expect(r.items.map((i) => i.url)).toEqual(['https://b']);
    expect(r.total).toBe(1);
  });

  it('includeRead returns all', async () => {
    const a = await saveItemImpl(db, userId, { url: 'https://a' });
    await markDoneImpl(db, userId, a.id);
    await saveItemImpl(db, userId, { url: 'https://b' });
    const r = await listItemsImpl(db, userId, { includeRead: true });
    expect(r.items.length).toBe(2);
  });

  it('filters by tag', async () => {
    await saveItemImpl(db, userId, { url: 'https://a', tags: ['rust'] });
    await saveItemImpl(db, userId, { url: 'https://b', tags: ['go'] });
    const r = await listItemsImpl(db, userId, { tag: 'rust' });
    expect(r.items.map((i) => i.url)).toEqual(['https://a']);
  });

  it('returns hostname for each row', async () => {
    await saveItemImpl(db, userId, { url: 'https://example.com/x' });
    const r = await listItemsImpl(db, userId);
    expect(r.items[0]!.hostname).toBe('example.com');
  });

  it('honours limit + clamps to 200', async () => {
    for (let i = 0; i < 3; i++) {
      await saveItemImpl(db, userId, { url: `https://x${i}.com` });
    }
    expect((await listItemsImpl(db, userId, { limit: 2 })).items.length).toBe(2);
    expect((await listItemsImpl(db, userId, { limit: 0 })).items.length).toBeGreaterThan(0);
    expect((await listItemsImpl(db, userId, { limit: 99999 })).items.length).toBeGreaterThan(0);
  });

  it('does not leak other users\' items', async () => {
    const other = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    await saveItemImpl(db, other.id, { url: 'https://bob' });
    expect((await listItemsImpl(db, userId)).items).toEqual([]);
  });

  it('ignores empty tag filter', async () => {
    await saveItemImpl(db, userId, { url: 'https://a' });
    const r = await listItemsImpl(db, userId, { tag: '' });
    expect(r.items.length).toBe(1);
  });
});

// ---------- getItemImpl ----------

describe('getItemImpl', () => {
  it('returns the row when owned', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com', tags: ['t'] });
    const got = await getItemImpl(db, u.id, r.id);
    expect(got?.url).toBe('https://x.com');
    expect(got?.tags).toEqual(['t']);
    expect(got?.hostname).toBe('x.com');
  });

  it('returns null when not owned', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveItemImpl(db, alice.id, { url: 'https://a.com' });
    expect(await getItemImpl(db, bob.id, r.id)).toBeNull();
  });

  it('returns null when not found', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await getItemImpl(db, u.id, 999_999)).toBeNull();
  });

  it('returns word_count + content_html when extracted', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const longBody = 'word '.repeat(500);
    const html = `<html><head><title>X</title></head><body><article><h1>Headline</h1><p>${longBody}</p></article></body></html>`;
    const saved = await saveItemImpl(
      db,
      u.id,
      { url: 'https://example.com' },
      undefined,
      {
        fetch: (async () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch,
      },
    );
    const got = await getItemImpl(db, u.id, saved.id);
    expect(got?.wordCount).toBeGreaterThan(0);
    expect(got?.contentHtml).toBeTruthy();
  });
});

// ---------- markDoneImpl ----------

describe('markDoneImpl', () => {
  it('sets read_at on the user\'s unread item', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com' });
    const now = new Date('2026-05-24T11:00:00Z');
    expect(await markDoneImpl(db, u.id, r.id, now)).toBe(true);
    const got = await getItemImpl(db, u.id, r.id);
    expect(got?.readAt).toBe(now.toISOString());
  });

  it('returns false if already read', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com' });
    expect(await markDoneImpl(db, u.id, r.id)).toBe(true);
    expect(await markDoneImpl(db, u.id, r.id)).toBe(false);
  });

  it('returns false if not owned', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveItemImpl(db, alice.id, { url: 'https://x.com' });
    expect(await markDoneImpl(db, bob.id, r.id)).toBe(false);
  });
});

// ---------- skipItemImpl ----------

describe('skipItemImpl', () => {
  it('bumps skipped_count', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com' });
    expect(await skipItemImpl(db, u.id, r.id)).toBe(true);
    expect(await skipItemImpl(db, u.id, r.id)).toBe(true);
    const got = await getItemImpl(db, u.id, r.id);
    expect(got?.skippedCount).toBe(2);
  });

  it('does not skip a read item', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com' });
    await markDoneImpl(db, u.id, r.id);
    expect(await skipItemImpl(db, u.id, r.id)).toBe(false);
  });

  it('returns false if not owned', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveItemImpl(db, alice.id, { url: 'https://x.com' });
    expect(await skipItemImpl(db, bob.id, r.id)).toBe(false);
  });
});

// ---------- deleteItemImpl ----------

describe('deleteItemImpl', () => {
  it('deletes the user\'s item', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveItemImpl(db, u.id, { url: 'https://x.com' });
    expect(await deleteItemImpl(db, u.id, r.id)).toBe(true);
    expect(await getItemImpl(db, u.id, r.id)).toBeNull();
  });

  it('returns false when not owned', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveItemImpl(db, alice.id, { url: 'https://x.com' });
    expect(await deleteItemImpl(db, bob.id, r.id)).toBe(false);
  });

  it('returns false when missing', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await deleteItemImpl(db, u.id, 9_999)).toBe(false);
  });
});

// ---------- loadQueueImpl ----------

describe('loadQueueImpl', () => {
  it('returns null with no sub', async () => {
    const db = await makeTestDb();
    expect(await loadQueueImpl(db, null)).toBeNull();
  });

  it('returns null when sub doesn\'t map', async () => {
    const db = await makeTestDb();
    expect(await loadQueueImpl(db, 'nope')).toBeNull();
  });

  it('returns me + next + unread count in one round-trip', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await saveItemImpl(db, u.id, { url: 'https://a.com' }, new Date('2026-05-24T09:00:00Z'));
    await saveItemImpl(db, u.id, { url: 'https://b.com' }, new Date('2026-05-24T09:01:00Z'));
    const r = await loadQueueImpl(db, 'sso-alice');
    expect(r?.me.login).toBe('alice');
    expect(r?.next?.url).toBe('https://a.com');
    expect(r?.unreadCount).toBe(2);
  });

  it('returns next = null when queue is empty', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const r = await loadQueueImpl(db, 'sso-alice');
    expect(r?.next).toBeNull();
    expect(r?.unreadCount).toBe(0);
  });

  it('honours freeMinutes priority', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const long = await saveItemImpl(db, u.id, { url: 'https://long' }, new Date('2026-05-24T09:00:00Z'));
    await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 30 WHERE id = ${long.id}`);
    const short = await saveItemImpl(db, u.id, { url: 'https://short' }, new Date('2026-05-24T09:05:00Z'));
    await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 5 WHERE id = ${short.id}`);
    const r = await loadQueueImpl(db, 'sso-alice', 10);
    expect(r?.next?.url).toBe('https://short');
  });
});

// ---------- findApiClientImpl ----------

describe('findApiClientImpl', () => {
  it('finds the row by client_id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await db.execute(sql`
      INSERT INTO read_later.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'secret-xyz', ${u.id})
    `);
    const got = await findApiClientImpl(db, 'cli-test');
    expect(got?.name).toBe('CLI');
    expect(got?.userId).toBe(u.id);
  });
  it('returns null on miss', async () => {
    const db = await makeTestDb();
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

// ---------- API client admin ----------

describe('issueApiClientSchema', () => {
  it('rejects bad client_id chars', () => {
    expect(issueApiClientSchema.safeParse({ clientId: 'with space', name: 'x' }).success).toBe(false);
  });
  it('rejects long client_id', () => {
    expect(issueApiClientSchema.safeParse({ clientId: 'a'.repeat(65), name: 'x' }).success).toBe(false);
  });
  it('accepts valid input', () => {
    expect(issueApiClientSchema.safeParse({ clientId: 'cli', name: 'CLI' }).success).toBe(true);
  });
});

describe('issueApiClientImpl', () => {
  it('inserts and returns the secret', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const issued = await issueApiClientImpl(
      db,
      u.id,
      { clientId: 'cli-extra', name: 'My Token' },
      'super-secret-base64',
    );
    expect(issued.clientId).toBe('cli-extra');
    expect(issued.hmacSecret).toBe('super-secret-base64');
    expect(issued.id).toBeGreaterThan(0);

    const got = await findApiClientImpl(db, 'cli-extra');
    expect(got?.hmacSecret).toBe('super-secret-base64');
    expect(got?.userId).toBe(u.id);
  });
});

describe('listApiClientsImpl', () => {
  it('returns the user\'s clients, newest first', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await issueApiClientImpl(
      db,
      u.id,
      { clientId: 'older', name: 'older' },
      's1',
      new Date('2026-05-24T09:00:00Z'),
    );
    await issueApiClientImpl(
      db,
      u.id,
      { clientId: 'newer', name: 'newer' },
      's2',
      new Date('2026-05-24T09:01:00Z'),
    );
    const list = await listApiClientsImpl(db, u.id);
    // The migration auto-seeds a 'cli' row for user_id=1.  Filter it out so
    // this test passes regardless of whether alice happens to be user 1.
    expect(
      list.filter((c) => c.clientId !== 'cli').map((c) => c.clientId),
    ).toEqual(['newer', 'older']);
  });

  it('does not leak other users\' clients', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    await issueApiClientImpl(db, alice.id, { clientId: 'a', name: 'a' }, 's');
    const list = await listApiClientsImpl(db, bob.id);
    expect(list).toEqual([]);
  });
});

// ---------- findUserBySsoImpl ----------

describe('findUserBySsoImpl', () => {
  it('round-trips a JWT sub → pm.users row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'carol', sub: 'sso-carol' });
    const found = await findUserBySsoImpl(db, 'sso-carol');
    expect(found?.id).toBe(u.id);
    expect(found?.login).toBe('carol');
    expect(found?.isAdmin).toBe(false);
  });
  it('returns null when no row maps the sub', async () => {
    const db = await makeTestDb();
    expect(await findUserBySsoImpl(db, 'unknown-sub')).toBeNull();
  });
  it('reflects admin flag', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'root', sub: 'sso-root', admin: true });
    const got = await findUserBySsoImpl(db, 'sso-root');
    expect(got?.isAdmin).toBe(true);
  });
});
