import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import {
  _testing,
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  deleteEntryImpl,
  findApiClientImpl,
  getEntryImpl,
  listApiClientsImpl,
  loadHomeImpl,
  saveEntryImpl,
  saveSchema,
  searchEntriesImpl,
  updateEntryImpl,
  updateSchema,
} from '~/server/solved';
import { findUserBySsoImpl } from '~/server/users';

describe('saveSchema', () => {
  it('requires title + body', () => {
    expect(saveSchema.safeParse({}).success).toBe(false);
    expect(saveSchema.safeParse({ title: 't', body: '' }).success).toBe(false);
    expect(saveSchema.safeParse({ title: '', body: 'x' }).success).toBe(false);
  });
  it('rejects whitespace-only body', () => {
    expect(saveSchema.safeParse({ title: 't', body: '   ' }).success).toBe(false);
  });
  it('accepts minimal', () => {
    expect(saveSchema.safeParse({ title: 't', body: 'b' }).success).toBe(true);
  });
  it('rejects bad sourceUrl', () => {
    expect(saveSchema.safeParse({ title: 't', body: 'b', sourceUrl: 'not a url' }).success).toBe(false);
  });
  it('accepts sourceRef + sourceUrl', () => {
    expect(
      saveSchema.safeParse({
        title: 't',
        body: 'b',
        sourceRef: 'pm:my-project#42',
        sourceUrl: 'https://example.com/pr/1',
      }).success,
    ).toBe(true);
  });
  it('caps tag count', () => {
    expect(
      saveSchema.safeParse({
        title: 't',
        body: 'b',
        tags: Array.from({ length: 33 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('updateSchema', () => {
  it('requires at least one field', () => {
    expect(updateSchema.safeParse({}).success).toBe(false);
  });
  it('accepts a body-only patch', () => {
    expect(updateSchema.safeParse({ body: 'new' }).success).toBe(true);
  });
  it('accepts a tags-only patch', () => {
    expect(updateSchema.safeParse({ tags: ['a'] }).success).toBe(true);
  });
});

describe('saveEntryImpl + getEntryImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts an entry + retrieves it', async () => {
    const created = await saveEntryImpl(db, userId, {
      title: 'Fix CORS in workerd',
      body: 'Add `Access-Control-Allow-Origin` header in the Hono middleware.',
      tags: ['e2e-test', 'cors'],
      source: 'cli',
      sourceRef: 'pm:pm#42',
      sourceUrl: 'https://example.com/pr/42',
    });
    expect(created.id).toBeGreaterThan(0);
    const got = await getEntryImpl(db, userId, created.id);
    expect(got?.title).toBe('Fix CORS in workerd');
    expect(got?.tags).toEqual(['e2e-test', 'cors']);
    expect(got?.source).toBe('cli');
    expect(got?.sourceRef).toBe('pm:pm#42');
    expect(got?.sourceUrl).toBe('https://example.com/pr/42');
  });

  it('defaults tags/source to empty/null', async () => {
    const created = await saveEntryImpl(db, userId, {
      title: 't',
      body: 'b',
    });
    const got = await getEntryImpl(db, userId, created.id);
    expect(got?.tags).toEqual([]);
    expect(got?.source).toBeNull();
    expect(got?.sourceRef).toBeNull();
    expect(got?.sourceUrl).toBeNull();
  });

  it('returns null for unknown id', async () => {
    expect(await getEntryImpl(db, userId, 99_999)).toBeNull();
  });

  it('returns null for cross-user id', async () => {
    const other = await insertPmUser(db, { login: 'bob', sub: 'sso-b' });
    const created = await saveEntryImpl(db, other.id, { title: 't', body: 'b' });
    expect(await getEntryImpl(db, userId, created.id)).toBeNull();
  });
});

describe('updateEntryImpl', () => {
  let db: TestDB;
  let userId: number;
  let entryId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    const r = await saveEntryImpl(db, userId, { title: 'old', body: 'orig' });
    entryId = r.id;
  });

  it('updates title only', async () => {
    const updated = await updateEntryImpl(db, userId, entryId, { title: 'new' });
    expect(updated?.title).toBe('new');
    expect(updated?.body).toBe('orig');
  });

  it('updates body only', async () => {
    const updated = await updateEntryImpl(db, userId, entryId, { body: 'new body' });
    expect(updated?.body).toBe('new body');
  });

  it('updates tags only — with quote/backslash escaping', async () => {
    const updated = await updateEntryImpl(db, userId, entryId, {
      tags: ['a', 'has "quote"', 'has\\back'],
    });
    expect(updated?.tags).toEqual(['a', 'has "quote"', 'has\\back']);
  });

  it('returns null for an entry not owned by the user', async () => {
    const other = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    expect(await updateEntryImpl(db, other.id, entryId, { body: 'x' })).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await updateEntryImpl(db, userId, 99_999, { body: 'x' })).toBeNull();
  });
});

describe('deleteEntryImpl', () => {
  it('deletes when owned', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await saveEntryImpl(db, u.id, { title: 't', body: 'b' });
    expect(await deleteEntryImpl(db, u.id, r.id)).toBe(true);
    expect(await getEntryImpl(db, u.id, r.id)).toBeNull();
  });

  it('false for foreign delete', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await saveEntryImpl(db, a.id, { title: 't', body: 'b' });
    expect(await deleteEntryImpl(db, b.id, r.id)).toBe(false);
  });

  it('false for unknown id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await deleteEntryImpl(db, u.id, 99_999)).toBe(false);
  });
});

describe('searchEntriesImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    await saveEntryImpl(db, userId, {
      title: '[e2e] Fix CORS in workerd',
      body: 'Add header to Hono middleware.',
      tags: ['e2e-test', 'cors'],
    });
    await saveEntryImpl(db, userId, {
      title: '[e2e] Docker compose volume mount',
      body: 'use bind mount not named volume.',
      tags: ['e2e-test', 'docker'],
    });
  });

  it('returns body-matching hits w/ headline', async () => {
    const hits = await searchEntriesImpl(db, userId, 'header');
    expect(hits.length).toBe(1);
    expect(hits[0]!.title).toMatch(/CORS/);
    expect(hits[0]!.headline).toBeTruthy();
  });

  it('respects limit', async () => {
    const hits = await searchEntriesImpl(db, userId, 'e2e', 1);
    expect(hits.length).toBe(1);
  });

  it('returns [] for no matches', async () => {
    const hits = await searchEntriesImpl(db, userId, 'unicorn');
    expect(hits).toEqual([]);
  });

  it('per-user scoping', async () => {
    const other = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    expect(await searchEntriesImpl(db, other.id, 'header')).toEqual([]);
  });

  it('clamps absurd limits', async () => {
    const hits = await searchEntriesImpl(db, userId, 'compose', 0);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('loadHomeImpl', () => {
  it('null when no sub', async () => {
    expect(await loadHomeImpl(await makeTestDb(), null)).toBeNull();
  });

  it('null when sub does not map', async () => {
    expect(await loadHomeImpl(await makeTestDb(), 'nope')).toBeNull();
  });

  it('returns me + recent entries DESC', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    await saveEntryImpl(db, u.id, { title: '[e2e] first', body: 'b' });
    await saveEntryImpl(db, u.id, { title: '[e2e] second', body: 'b' });
    const home = await loadHomeImpl(db, 'sso-a');
    expect(home?.me.login).toBe('a');
    expect(home?.entries.length).toBe(2);
    expect(home?.entries[0]!.title).toBe('[e2e] second');
  });

  it('returns empty array when user has no entries', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const home = await loadHomeImpl(db, 'sso-a');
    expect(home?.entries).toEqual([]);
  });
});

describe('findApiClientImpl', () => {
  it('finds a row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO solved.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'sec', ${u.id})
    `);
    const r = await findApiClientImpl(db, 'cli-test');
    expect(r?.name).toBe('CLI');
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

describe('createApiClientSchema', () => {
  it('rejects bad client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'BAD', name: 'x' }).success).toBe(false);
  });
  it('accepts kebab-case ids', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'ext-1', name: 'x' }).success).toBe(true);
  });
});

describe('api-client CRUD', () => {
  async function clearSeed(db: TestDB) {
    await db.execute(sql`DELETE FROM solved.api_clients`);
  }

  it('createApiClientImpl inserts + returns plaintext secret', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createApiClientImpl(db, u.id, { clientId: 'ext-1', name: 'Ext' }, now);
    expect(r.clientId).toBe('ext-1');
    expect(r.hmacSecret.length).toBeGreaterThan(20);
    expect(r.createdAt).toBe(now.toISOString());
  });

  it('listApiClientsImpl returns DESC + per-user scoping', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await createApiClientImpl(db, a.id, { clientId: 'x', name: 'X' }, t0);
    await createApiClientImpl(db, a.id, { clientId: 'y', name: 'Y' }, new Date(t0.getTime() + 60_000));
    const list = await listApiClientsImpl(db, a.id);
    expect(list.map((c) => c.clientId)).toEqual(['y', 'x']);
    expect(await listApiClientsImpl(db, b.id)).toEqual([]);
  });

  it('deleteApiClientImpl removes / refuses foreign / handles unknown', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await deleteApiClientImpl(db, b.id, 'a-cli')).toBe(false);
    expect(await deleteApiClientImpl(db, a.id, 'a-cli')).toBe(true);
    expect(await deleteApiClientImpl(db, a.id, 'nope')).toBe(false);
  });
});

describe('findUserBySsoImpl', () => {
  it('finds an active user', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const found = await findUserBySsoImpl(db, 'sso-a');
    expect(found?.id).toBe(u.id);
    expect(found?.login).toBe('a');
    expect(found?.isAdmin).toBe(false);
  });
  it('null for unknown sub', async () => {
    expect(await findUserBySsoImpl(await makeTestDb(), 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('parsePgArrayLiteral', () => {
    const f = _testing.parsePgArrayLiteral;
    expect(f('{}')).toEqual([]);
    expect(f('foo')).toEqual([]);
    expect(f('{a,b,c}')).toEqual(['a', 'b', 'c']);
    expect(f('{"hello, world",plain}')).toEqual(['hello, world', 'plain']);
    expect(f('{"with \\"quote\\""}')).toEqual(['with "quote"']);
  });
  it('normaliseTags', () => {
    const n = _testing.normaliseTags;
    expect(n(['a', 'b'])).toEqual(['a', 'b']);
    expect(n(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(n('{e2e-test,curl}')).toEqual(['e2e-test', 'curl']);
    expect(n(null)).toEqual([]);
    expect(n(42)).toEqual([]);
  });
});
