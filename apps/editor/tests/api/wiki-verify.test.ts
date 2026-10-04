// Phase 15 unit tests for the wiki + verified-page impls in pages.ts.

import { describe, it, expect } from 'vitest';
import { setWikiImpl, setVerifiedImpl, wikiEntriesImpl } from '@api/handlers/pages';
import type { Sql } from '@api/lib/db';

describe('setWikiImpl', () => {
  it('returns the new isWiki state', async () => {
    const sql = (() => Promise.resolve([{ isWiki: true }])) as unknown as Sql;
    expect(await setWikiImpl(sql, 'p1', true)).toEqual({ isWiki: true });
  });
  it('returns null for a missing page', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    expect(await setWikiImpl(sql, 'nope', true)).toBeNull();
  });
});

describe('setVerifiedImpl', () => {
  it('stamps verifier + time when verifying', async () => {
    // The impl embeds a nested `sql`now()`` for the verified branch; the fake
    // simply returns the canned UPDATE ... RETURNING rows for any call.
    const sql = (() =>
      Promise.resolve([
        { verified: true, verifiedBy: 'alice@x.com', verifiedAt: '2026-06-02T00:00:00Z' },
      ])) as unknown as Sql;
    const res = await setVerifiedImpl(sql, 'p1', true, 'alice@x.com');
    expect(res).toEqual({
      verified: true,
      verifiedBy: 'alice@x.com',
      verifiedAt: '2026-06-02T00:00:00Z',
    });
  });

  it('clears verifier on unverify', async () => {
    const sql = (() =>
      Promise.resolve([{ verified: false, verifiedBy: null, verifiedAt: null }])) as unknown as Sql;
    const res = await setVerifiedImpl(sql, 'p1', false, 'alice@x.com');
    expect(res).toEqual({ verified: false, verifiedBy: null, verifiedAt: null });
  });

  it('returns null for a missing page', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    expect(await setVerifiedImpl(sql, 'nope', true, 'a')).toBeNull();
  });
});

describe('wikiEntriesImpl', () => {
  it('maps child rows with verified state + last-edited', async () => {
    const sql = (() =>
      Promise.resolve([
        {
          id: 'c1',
          title: 'Onboarding',
          icon: '📘',
          verified: true,
          verifiedBy: 'bob',
          verifiedAt: '2026-06-01T00:00:00Z',
          updatedAt: '2026-06-02T00:00:00Z',
        },
        {
          id: 'c2',
          title: 'Draft',
          icon: null,
          verified: false,
          verifiedBy: null,
          verifiedAt: null,
          updatedAt: '2026-06-02T00:00:00Z',
        },
      ])) as unknown as Sql;
    const entries = await wikiEntriesImpl(sql, 'wiki1');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'c1', verified: true, verifiedBy: 'bob' });
    expect(entries[1]).toMatchObject({ id: 'c2', verified: false, verifiedBy: null, verifiedAt: null });
  });
});
