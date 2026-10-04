import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  deleteSnippetImpl,
  findApiClientImpl,
  getSnippetImpl,
  listApiClientsImpl,
  listQuerySchema,
  listSnippetsImpl,
  loadHomeImpl,
  saveSchema,
  saveSnippetImpl,
  searchQuerySchema,
  searchSnippetsImpl,
  updateSchema,
  updateSnippetImpl,
} from '~/server/stash';
import { findUserBySsoImpl } from '~/server/users';

// ---------- schemas ----------

describe('saveSchema', () => {
  it('rejects empty body', () => {
    expect(saveSchema.safeParse({ body: '' }).success).toBe(false);
  });
  it('rejects whitespace-only body', () => {
    expect(saveSchema.safeParse({ body: '   \n\t' }).success).toBe(false);
  });
  it('rejects body > 256 KB', () => {
    expect(saveSchema.safeParse({ body: 'x'.repeat(300_000) }).success).toBe(false);
  });
  it('rejects > 32 tags', () => {
    expect(
      saveSchema.safeParse({
        body: 'x',
        tags: Array.from({ length: 33 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });
  it('rejects an empty tag', () => {
    expect(saveSchema.safeParse({ body: 'x', tags: [''] }).success).toBe(false);
  });
  it('rejects title > 200 chars', () => {
    expect(saveSchema.safeParse({ body: 'x', title: 'a'.repeat(201) }).success).toBe(false);
  });
  it('accepts a minimal valid payload', () => {
    const r = saveSchema.safeParse({ body: 'curl example.com' });
    expect(r.success).toBe(true);
  });
  it('accepts the full payload shape', () => {
    const r = saveSchema.safeParse({
      title: 'curl example',
      body: 'curl example.com',
      language: 'sh',
      tags: ['curl', 'http'],
      source: 'cli',
    });
    expect(r.success).toBe(true);
  });
});

describe('listQuerySchema', () => {
  it('defaults limit + page', () => {
    const r = listQuerySchema.parse({});
    expect(r.limit).toBe(20);
    expect(r.page).toBe(1);
  });
  it('rejects non-int limit', () => {
    expect(listQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });
  it('rejects limit > 100', () => {
    expect(listQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
  });
  it('rejects page < 1', () => {
    expect(listQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe('searchQuerySchema', () => {
  it('rejects empty q', () => {
    expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });
  it('rejects q > 400 chars', () => {
    expect(searchQuerySchema.safeParse({ q: 'a'.repeat(401) }).success).toBe(false);
  });
  it('defaults limit to 50', () => {
    const r = searchQuerySchema.parse({ q: 'x' });
    expect(r.limit).toBe(50);
  });
});

describe('updateSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateSchema.safeParse({}).success).toBe(false);
  });
  it('accepts title-only patch (including null)', () => {
    expect(updateSchema.safeParse({ title: 'new title' }).success).toBe(true);
    expect(updateSchema.safeParse({ title: null }).success).toBe(true);
  });
  it('accepts language-only patch (including null)', () => {
    expect(updateSchema.safeParse({ language: 'sh' }).success).toBe(true);
    expect(updateSchema.safeParse({ language: null }).success).toBe(true);
  });
  it('accepts a body-only patch', () => {
    expect(updateSchema.safeParse({ body: 'curl x' }).success).toBe(true);
  });
  it('accepts a tags-only patch', () => {
    expect(updateSchema.safeParse({ tags: ['x'] }).success).toBe(true);
  });
  it('rejects an empty body field', () => {
    expect(updateSchema.safeParse({ body: '' }).success).toBe(false);
  });
});

// ---------- saveSnippetImpl ----------

describe('saveSnippetImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a snippet and returns the row', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await saveSnippetImpl(
      db,
      userId,
      { body: 'curl example.com', title: 'curl', language: 'sh', tags: ['curl', 'http'] },
      now,
    );
    expect(typeof r.id).toBe('number');
    expect(r.title).toBe('curl');
    expect(r.createdAt.toISOString()).toBe(now.toISOString());
  });

  it('persists null title / language when omitted', async () => {
    const r = await saveSnippetImpl(db, userId, { body: 'just body' });
    const got = await getSnippetImpl(db, userId, r.id);
    expect(got?.title).toBeNull();
    expect(got?.language).toBeNull();
    expect(got?.tags).toEqual([]);
  });

  it('stamps the source field', async () => {
    const r = await saveSnippetImpl(db, userId, {
      body: 'curl',
      source: 'cli',
    });
    const got = await getSnippetImpl(db, userId, r.id);
    expect(got?.source).toBe('cli');
  });
});

// ---------- listSnippetsImpl ----------

describe('listSnippetsImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns [] + total=0 when the user has no snippets', async () => {
    const r = await listSnippetsImpl(db, userId);
    expect(r.snippets).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('returns snippets in created_at DESC order', async () => {
    const t0 = new Date('2026-05-24T09:00:00Z');
    await saveSnippetImpl(db, userId, { body: 'old', title: 'old' }, t0);
    await saveSnippetImpl(
      db,
      userId,
      { body: 'newer', title: 'newer' },
      new Date(t0.getTime() + 60_000),
    );
    const r = await listSnippetsImpl(db, userId);
    expect(r.snippets.map((s) => s.title)).toEqual(['newer', 'old']);
    expect(r.total).toBe(2);
  });

  it('paginates by page + limit', async () => {
    for (let i = 0; i < 5; i++) {
      await saveSnippetImpl(db, userId, { body: `b${i}`, title: `t${i}` });
    }
    const page1 = await listSnippetsImpl(db, userId, 2, 1);
    expect(page1.snippets.length).toBe(2);
    expect(page1.total).toBe(5);
    const page3 = await listSnippetsImpl(db, userId, 2, 3);
    expect(page3.snippets.length).toBe(1);
  });

  it('caps the limit at 100 + clamps page at 1', async () => {
    await saveSnippetImpl(db, userId, { body: 'x' });
    expect((await listSnippetsImpl(db, userId, 9999, 0)).snippets.length).toBe(1);
  });

  it('truncates long bodies in the preview', async () => {
    const long = 'a'.repeat(2000);
    await saveSnippetImpl(db, userId, { body: long });
    const r = await listSnippetsImpl(db, userId);
    expect(r.snippets[0]!.body.length).toBeLessThan(long.length);
  });

  it('does not leak other users\' snippets', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
    await saveSnippetImpl(db, other.id, { body: 'theirs' });
    const r = await listSnippetsImpl(db, userId);
    expect(r.snippets).toEqual([]);
  });
});

// ---------- getSnippetImpl ----------

describe('getSnippetImpl', () => {
  it('returns the snippet for the owning user', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnippetImpl(db, u.id, {
      body: 'curl example.com',
      title: 'curl',
      language: 'sh',
      tags: ['curl'],
    });
    const got = await getSnippetImpl(db, u.id, r.id);
    expect(got?.title).toBe('curl');
    expect(got?.body).toBe('curl example.com');
    expect(got?.language).toBe('sh');
    expect(got?.tags).toEqual(['curl']);
  });

  it('returns null when the id belongs to another user', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await saveSnippetImpl(db, a.id, { body: 'mine' });
    expect(await getSnippetImpl(db, b.id, r.id)).toBeNull();
  });

  it('returns null when the id does not exist', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await getSnippetImpl(db, u.id, 99999)).toBeNull();
  });
});

// ---------- updateSnippetImpl ----------

describe('updateSnippetImpl', () => {
  it('patches title only', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnippetImpl(db, u.id, { body: 'x', title: 'orig' });
    const updated = await updateSnippetImpl(db, u.id, r.id, { title: 'new' });
    expect(updated?.title).toBe('new');
    expect(updated?.body).toBe('x');
  });

  it('patches body / language / tags', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnippetImpl(db, u.id, { body: 'orig', language: 'sh' });
    const updated = await updateSnippetImpl(db, u.id, r.id, {
      body: 'new body',
      language: 'js',
      tags: ['a', 'b'],
    });
    expect(updated?.body).toBe('new body');
    expect(updated?.language).toBe('js');
    expect(updated?.tags).toEqual(['a', 'b']);
  });

  it('clears title / language via null', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnippetImpl(db, u.id, {
      body: 'x',
      title: 't',
      language: 'sh',
    });
    const updated = await updateSnippetImpl(db, u.id, r.id, { title: null, language: null });
    expect(updated?.title).toBeNull();
    expect(updated?.language).toBeNull();
  });

  it('advances updated_at', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    const r = await saveSnippetImpl(db, u.id, { body: 'x' }, t0);
    const t1 = new Date('2026-05-24T11:00:00Z');
    const updated = await updateSnippetImpl(db, u.id, r.id, { body: 'y' }, t1);
    expect(updated?.updatedAt).toBe(t1.toISOString());
  });

  it('returns null when the snippet does not belong to the user', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await saveSnippetImpl(db, a.id, { body: 'mine' });
    expect(await updateSnippetImpl(db, b.id, r.id, { body: 'pwned' })).toBeNull();
  });

  it('returns null for a non-existent id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await updateSnippetImpl(db, u.id, 99999, { body: 'x' })).toBeNull();
  });
});

// ---------- deleteSnippetImpl ----------

describe('deleteSnippetImpl', () => {
  it('deletes the user\'s snippet', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnippetImpl(db, u.id, { body: 'x' });
    expect(await deleteSnippetImpl(db, u.id, r.id)).toBe(true);
    expect(await getSnippetImpl(db, u.id, r.id)).toBeNull();
  });

  it('refuses to delete another user\'s snippet', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await saveSnippetImpl(db, a.id, { body: 'x' });
    expect(await deleteSnippetImpl(db, b.id, r.id)).toBe(false);
    expect(await getSnippetImpl(db, a.id, r.id)).not.toBeNull();
  });

  it('returns false for a non-existent id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await deleteSnippetImpl(db, u.id, 99999)).toBe(false);
  });
});

// ---------- searchSnippetsImpl ----------

describe('searchSnippetsImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns [] when nothing matches', async () => {
    await saveSnippetImpl(db, userId, { body: 'unrelated content' });
    expect(await searchSnippetsImpl(db, userId, 'zebra')).toEqual([]);
  });

  it('finds matches in the body', async () => {
    await saveSnippetImpl(db, userId, { body: 'curl example.com --header foo' });
    await saveSnippetImpl(db, userId, { body: 'docker compose up' });
    const hits = await searchSnippetsImpl(db, userId, 'curl');
    expect(hits.length).toBe(1);
    expect(hits[0]!.body).toMatch(/curl/);
  });

  it('finds matches in the title with higher rank than body matches', async () => {
    await saveSnippetImpl(db, userId, {
      title: 'random',
      body: 'mentions curl somewhere in the middle of the body text',
    });
    await saveSnippetImpl(db, userId, {
      title: 'curl recipes',
      body: 'unrelated body text here',
    });
    const hits = await searchSnippetsImpl(db, userId, 'curl');
    expect(hits.length).toBe(2);
    // Title match (weight A) outranks body match (weight B).
    expect(hits[0]!.title).toBe('curl recipes');
  });

  it('finds matches via tags', async () => {
    await saveSnippetImpl(db, userId, {
      title: 'random',
      body: 'something else',
      tags: ['curl', 'http'],
    });
    const hits = await searchSnippetsImpl(db, userId, 'curl');
    expect(hits.length).toBe(1);
  });

  it('returns a headline with <b>...</b> markers', async () => {
    await saveSnippetImpl(db, userId, {
      body: 'this is a long body where curl appears here',
    });
    const hits = await searchSnippetsImpl(db, userId, 'curl');
    expect(hits[0]!.headline).toMatch(/<b>curl<\/b>/i);
  });

  it('respects the per-user scope', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
    await saveSnippetImpl(db, other.id, { body: 'curl example.com' });
    expect(await searchSnippetsImpl(db, userId, 'curl')).toEqual([]);
  });

  it('caps + clamps the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSnippetImpl(db, userId, { body: `curl ${i}` });
    }
    expect((await searchSnippetsImpl(db, userId, 'curl', 2)).length).toBe(2);
    expect((await searchSnippetsImpl(db, userId, 'curl', 0)).length).toBeGreaterThan(0);
    expect((await searchSnippetsImpl(db, userId, 'curl', 9999)).length).toBe(3);
  });
});

// ---------- loadHomeImpl ----------

describe('loadHomeImpl', () => {
  it('returns null when sub is missing', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map to a pm.users row', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, 'nope')).toBeNull();
  });

  it('returns me + most-recent snippets + total in one round-trip', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await saveSnippetImpl(db, u.id, { body: 'oldest' }, t0);
    await saveSnippetImpl(db, u.id, { body: 'middle' }, new Date(t0.getTime() + 60_000));
    await saveSnippetImpl(db, u.id, { body: 'newest' }, new Date(t0.getTime() + 120_000));
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.me.login).toBe('alice');
    expect(home?.snippets.map((s) => s.body)).toEqual(['newest', 'middle', 'oldest']);
    expect(home?.total).toBe(3);
    expect(home?.page).toBe(1);
    expect(home?.pageSize).toBe(20);
  });

  it('paginates', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    for (let i = 0; i < 5; i++) {
      await saveSnippetImpl(db, u.id, { body: `b${i}` });
    }
    const home = await loadHomeImpl(db, 'sso-alice', 2, 2);
    expect(home?.snippets.length).toBe(2);
    expect(home?.page).toBe(2);
    expect(home?.total).toBe(5);
  });

  it('clamps page + pageSize', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const home = await loadHomeImpl(db, 'sso-alice', 0, 9999);
    expect(home?.page).toBe(1);
    expect(home?.pageSize).toBe(100);
  });
});

// ---------- findApiClientImpl ----------

describe('findApiClientImpl', () => {
  it('finds a row by client_id, returns null otherwise', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await db.execute(sql`
      INSERT INTO stash.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'secret-xyz', ${u.id})
    `);
    const found = await findApiClientImpl(db, 'cli-test');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('CLI');
    expect(found!.userId).toBe(u.id);
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
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
});

// ---------- api-client management impls ----------

describe('createApiClientSchema', () => {
  it('rejects invalid client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'BAD', name: 'x' }).success).toBe(false);
    expect(createApiClientSchema.safeParse({ clientId: 'a', name: 'x' }).success).toBe(false);
    expect(createApiClientSchema.safeParse({ clientId: 'a!', name: 'x' }).success).toBe(false);
  });
  it('accepts a kebab-cased + digits client_id', () => {
    expect(
      createApiClientSchema.safeParse({ clientId: 'ext-laptop-1', name: 'x' }).success,
    ).toBe(true);
  });
});

describe('createApiClientImpl', () => {
  it('inserts a row + returns the plaintext secret', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createApiClientImpl(
      db,
      u.id,
      { clientId: 'ext-laptop', name: 'Laptop' },
      now,
    );
    expect(r.clientId).toBe('ext-laptop');
    expect(r.name).toBe('Laptop');
    expect(typeof r.hmacSecret).toBe('string');
    expect(r.hmacSecret.length).toBeGreaterThan(20);
    expect(r.createdAt).toBe(now.toISOString());
    const found = await findApiClientImpl(db, 'ext-laptop');
    expect(found!.hmacSecret).toBe(r.hmacSecret);
    expect(found!.userId).toBe(u.id);
  });
});

describe('listApiClientsImpl', () => {
  // Migration seeds a 'cli' row for user_id=1.  Strip it so the test
  // asserts on what *this* test inserts.
  async function clearSeed(db: TestDB) {
    await db.execute(sql`DELETE FROM stash.api_clients`);
  }

  it('returns the user\'s clients in created_at DESC order', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const u = await insertPmUser(db, { login: 'alice' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await createApiClientImpl(db, u.id, { clientId: 'a', name: 'A' }, t0);
    await createApiClientImpl(
      db,
      u.id,
      { clientId: 'b', name: 'B' },
      new Date(t0.getTime() + 60_000),
    );
    const list = await listApiClientsImpl(db, u.id);
    expect(list.map((c) => c.clientId)).toEqual(['b', 'a']);
  });

  it('does not leak other users\' clients', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await listApiClientsImpl(db, b.id)).toEqual([]);
  });
});

describe('deleteApiClientImpl', () => {
  it('removes the user\'s client', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await createApiClientImpl(db, u.id, { clientId: 'x', name: 'X' });
    expect(await deleteApiClientImpl(db, u.id, 'x')).toBe(true);
    expect(await findApiClientImpl(db, 'x')).toBeNull();
  });
  it('refuses to delete another user\'s client', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await deleteApiClientImpl(db, b.id, 'a-cli')).toBe(false);
    expect(await findApiClientImpl(db, 'a-cli')).not.toBeNull();
  });
  it('returns false for an unknown client', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await deleteApiClientImpl(db, u.id, 'nope')).toBe(false);
  });
});

// ---------- normaliseTags / parsePgArrayLiteral ----------
//
// pglite returns text[] columns as real JS arrays, so the postgres-literal
// path in normaliseTags isn't reachable through the integration suite.
// Exercise it directly via the _testing exports so production (postgres.js
// with fetch_types:false) behaviour is covered.

describe('_testing.parsePgArrayLiteral', () => {
  const f = _testing.parsePgArrayLiteral;
  it('parses the empty array literal', () => {
    expect(f('{}')).toEqual([]);
  });
  it('rejects non-array shapes', () => {
    expect(f('')).toEqual([]);
    expect(f('foo')).toEqual([]);
    expect(f('{foo')).toEqual([]);
  });
  it('parses unquoted elements', () => {
    expect(f('{a,b,c}')).toEqual(['a', 'b', 'c']);
  });
  it('parses quoted elements with commas + spaces', () => {
    expect(f('{"hello, world",plain}')).toEqual(['hello, world', 'plain']);
  });
  it('unescapes backslash sequences in quoted elements', () => {
    expect(f('{"with \\"quote\\"","back\\\\slash"}')).toEqual([
      'with "quote"',
      'back\\slash',
    ]);
  });
});

describe('_testing.normaliseTags', () => {
  const n = _testing.normaliseTags;
  it('passes a real array straight through', () => {
    expect(n(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('filters non-string entries out of an array', () => {
    expect(n(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });
  it('parses a postgres array literal string', () => {
    expect(n('{e2e-test,curl}')).toEqual(['e2e-test', 'curl']);
  });
  it('returns [] for anything else', () => {
    expect(n(null)).toEqual([]);
    expect(n(undefined)).toEqual([]);
    expect(n(42)).toEqual([]);
    expect(n({})).toEqual([]);
  });
});
