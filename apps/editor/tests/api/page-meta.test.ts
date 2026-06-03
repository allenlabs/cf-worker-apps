// Phase 14 unit tests for pages.ts: full_width patch, lock enforcement in
// canEditPageImpl, setLockedImpl, and duplicatePageImpl's deep-copy walk. We
// drive the impls with a fake `Sql` tagged-template that returns canned rows
// matched by a fragment of the query text (mirrors acl.test.ts / pages-cover).

import { describe, it, expect } from 'vitest';
import {
  updatePageImpl,
  setLockedImpl,
  canEditPageImpl,
  isPageLockedImpl,
  duplicatePageImpl,
  type PageFull,
} from '@api/handlers/pages';
import type { Sql } from '@api/lib/db';

const FULL_PAGE = (over: Partial<PageFull> = {}): PageFull => ({
  id: 'p1',
  workspaceId: 'ws',
  parentId: null,
  title: 'T',
  icon: null,
  cover: null,
  snapshotHtml: '<p></p>',
  kind: 'page',
  databaseId: null,
  public: false,
  restricted: false,
  fullWidth: false,
  locked: false,
  font: 'default',
  smallText: false,
  isWiki: false,
  verified: false,
  verifiedBy: null,
  verifiedAt: null,
  ...over,
});

// ---------- updatePageImpl: full_width ----------

describe('updatePageImpl — full_width', () => {
  function fakeSql() {
    let lastAssign: Record<string, unknown> | null = null;
    const sql = ((first: unknown, ...rest: unknown[]) => {
      if (!Array.isArray(first) || !('raw' in (first as object))) {
        lastAssign = first as Record<string, unknown>;
        return { __assign: true };
      }
      const strings = first as unknown as TemplateStringsArray;
      const text = strings.join('?');
      void rest;
      if (text.includes('snapshot_html AS')) return Promise.resolve([FULL_PAGE()]);
      return Promise.resolve([{ id: 'p1' }]);
    }) as unknown as Sql;
    return { sql, getAssign: () => lastAssign };
  }

  it('includes full_width in the assignment when toggled', async () => {
    const { sql, getAssign } = fakeSql();
    const ok = await updatePageImpl(sql, 'p1', { fullWidth: true });
    expect(ok).toBe(true);
    expect(getAssign()).toEqual({ full_width: true });
  });

  it('includes font + small_text in the assignment (Phase 18)', async () => {
    const { sql, getAssign } = fakeSql();
    const ok = await updatePageImpl(sql, 'p1', { font: 'serif', smallText: true });
    expect(ok).toBe(true);
    expect(getAssign()).toEqual({ font: 'serif', small_text: true });
  });

  it('omits typography columns absent from the patch', async () => {
    const { sql, getAssign } = fakeSql();
    await updatePageImpl(sql, 'p1', { fullWidth: false });
    expect(getAssign()).toEqual({ full_width: false });
  });
});

// ---------- isPageLockedImpl / setLockedImpl ----------

describe('lock impls', () => {
  it('isPageLockedImpl reads the locked column', async () => {
    const sql = (() => Promise.resolve([{ locked: true }])) as unknown as Sql;
    expect(await isPageLockedImpl(sql, 'p1')).toBe(true);
  });

  it('isPageLockedImpl returns false for a missing page', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    expect(await isPageLockedImpl(sql, 'nope')).toBe(false);
  });

  it('setLockedImpl returns the new locked value', async () => {
    const sql = (() => Promise.resolve([{ locked: true }])) as unknown as Sql;
    expect(await setLockedImpl(sql, 'p1', true)).toEqual({ locked: true });
  });

  it('setLockedImpl returns null when the page is missing', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    expect(await setLockedImpl(sql, 'nope', true)).toBeNull();
  });
});

// ---------- canEditPageImpl: lock enforcement ----------

describe('canEditPageImpl — lock enforcement', () => {
  /**
   * Drive both queries pageRoleImpl + isPageLockedImpl issue: the access-facts
   * CTE ("gated_teamspaces"), the membership probe ("workspace_members"), and
   * the lock probe ("SELECT locked").
   */
  function fakeSql(opts: { owner: boolean; locked: boolean }): Sql {
    return ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('gated_teamspaces')) {
        return Promise.resolve([
          {
            workspaceId: 'ws',
            ownerId: opts.owner ? 'u1' : 'other',
            shareRole: null,
            restricted: false,
            teamspaceBlocked: false,
          },
        ]);
      }
      if (text.includes('workspace_members')) return Promise.resolve([{ '?column?': 1 }]);
      if (text.includes('SELECT locked')) return Promise.resolve([{ locked: opts.locked }]);
      return Promise.resolve([]);
    }) as unknown as Sql;
  }

  it('an owner CAN edit an unlocked page', async () => {
    expect(await canEditPageImpl(fakeSql({ owner: true, locked: false }), 'u1', 'p1')).toBe(true);
  });

  it('a LOCKED page is NOT editable even by the owner', async () => {
    expect(await canEditPageImpl(fakeSql({ owner: true, locked: true }), 'u1', 'p1')).toBe(false);
  });
});

// ---------- duplicatePageImpl ----------

describe('duplicatePageImpl', () => {
  it('returns null when the source page does not exist', async () => {
    // getPageImpl's SELECT returns no rows.
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    expect(await duplicatePageImpl(sql, 'u1', 'missing')).toBeNull();
  });

  it('deep-copies the subtree, prefixes "Copy of " on the root, and returns a NEW root id', async () => {
    const inserts: { title: unknown; id: unknown; parentId: unknown }[] = [];
    const sql = ((first: unknown, ...rest: unknown[]) => {
      const strings = first as unknown as TemplateStringsArray;
      const text = strings.join('?');
      // getPageImpl (the source root lookup).
      if (text.includes('snapshot_html AS') && text.includes('full_width AS')) {
        return Promise.resolve([FULL_PAGE({ id: 'root', title: 'Doc', parentId: 'par' })]);
      }
      // The recursive subtree fetch.
      if (text.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve([
          { id: 'root', parentId: 'par', title: 'Doc', icon: null, cover: null, snapshotHtml: '<p>a</p>', kind: 'page', databaseId: null, dbProps: {}, position: 0, teamspaceId: null },
          { id: 'child', parentId: 'root', title: 'Child', icon: null, cover: null, snapshotHtml: '<p>b</p>', kind: 'page', databaseId: null, dbProps: {}, position: 1, teamspaceId: null },
        ]);
      }
      // INSERT INTO editor.pages — capture id/parent/title (params after the
      // tagged template; positions depend on the literal, so match by string).
      if (text.includes('INSERT INTO editor.pages')) {
        inserts.push({ id: rest[0], parentId: rest[2], title: rest[4] });
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    // sql.json passthrough used inside the INSERT.
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    const res = await duplicatePageImpl(sql, 'u1', 'root');
    expect(res).not.toBeNull();
    // Two pages inserted (root + child).
    expect(inserts).toHaveLength(2);
    // Root copy is re-parented to the original's parent + "Copy of " prefix.
    const rootInsert = inserts[0]!;
    const childInsert = inserts[1]!;
    expect(rootInsert.parentId).toBe('par');
    expect(rootInsert.title).toBe('Copy of Doc');
    // The returned id is the freshly-minted root id (not the original).
    expect(res!.id).toBe(rootInsert.id);
    expect(res!.id).not.toBe('root');
    // The child's parent is remapped to the new root id (not the old 'root').
    expect(childInsert.parentId).toBe(rootInsert.id);
    expect(childInsert.title).toBe('Child');
  });
});
