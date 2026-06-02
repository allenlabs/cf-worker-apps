// Unit tests for the Phase 10 per-page ACL impls in pages.ts. These speak raw
// parameterised SQL, so we drive them with a fake `Sql` tagged-template that
// returns canned rows per call (matched by a fragment of the query text).

import { describe, it, expect } from 'vitest';
import {
  pageRoleImpl,
  canAccessPageImpl,
  canEditPageImpl,
} from '@api/handlers/pages';
import type { Sql } from '@api/lib/db';

interface AccessRow {
  workspaceId: string | null;
  ownerId: string | null;
  shareRole: string | null;
  restricted: boolean;
  teamspaceBlocked: boolean;
}

/**
 * A fake Sql that answers the two queries pageRoleImpl can issue:
 *   - the access-facts recursive CTE (text contains "gated_teamspaces")
 *   - isMemberImpl's membership probe (text contains "workspace_members")
 */
function fakeSql(opts: { facts: AccessRow | null; isMember: boolean }): Sql {
  return ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('gated_teamspaces')) {
      return Promise.resolve(opts.facts ? [opts.facts] : [{}]);
    }
    if (text.includes('workspace_members')) {
      return Promise.resolve(opts.isMember ? [{ '?column?': 1 }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
}

const FACTS = (over: Partial<AccessRow> = {}): AccessRow => ({
  workspaceId: 'ws-1',
  ownerId: 'someone-else',
  shareRole: null,
  restricted: false,
  teamspaceBlocked: false,
  ...over,
});

describe('pageRoleImpl', () => {
  it('returns null when the page does not exist (no workspace)', async () => {
    const sql = fakeSql({ facts: { ...FACTS(), workspaceId: null }, isMember: true });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBeNull();
  });

  it('returns owner when the user owns the page (even if restricted)', async () => {
    const sql = fakeSql({ facts: FACTS({ ownerId: 'u', restricted: true }), isMember: false });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBe('owner');
  });

  it('returns edit for a workspace member on an unrestricted, open page', async () => {
    const sql = fakeSql({ facts: FACTS(), isMember: true });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBe('edit');
  });

  it('blocks membership on a restricted page, falling back to no share', async () => {
    const sql = fakeSql({ facts: FACTS({ restricted: true }), isMember: true });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBeNull();
  });

  it('honours an explicit edit share even when membership is blocked by restriction', async () => {
    const sql = fakeSql({ facts: FACTS({ restricted: true, shareRole: 'edit' }), isMember: false });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBe('edit');
  });

  it('returns view for a view-only share (no membership)', async () => {
    const sql = fakeSql({ facts: FACTS({ shareRole: 'view' }), isMember: false });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBe('view');
  });

  it('blocks membership when a gated teamspace excludes the user', async () => {
    const sql = fakeSql({ facts: FACTS({ teamspaceBlocked: true }), isMember: true });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBeNull();
  });

  it('still grants edit via membership when a teamspace is open (not blocked)', async () => {
    const sql = fakeSql({ facts: FACTS({ teamspaceBlocked: false }), isMember: true });
    expect(await pageRoleImpl(sql, 'u', 'p')).toBe('edit');
  });
});

describe('canAccessPageImpl / canEditPageImpl', () => {
  it('canAccess is true for any non-null role (e.g. view share)', async () => {
    const sql = fakeSql({ facts: FACTS({ shareRole: 'view' }), isMember: false });
    expect(await canAccessPageImpl(sql, 'u', 'p')).toBe(true);
  });

  it('canEdit is FALSE for a view-only share (read-only)', async () => {
    const sql = fakeSql({ facts: FACTS({ shareRole: 'view' }), isMember: false });
    expect(await canEditPageImpl(sql, 'u', 'p')).toBe(false);
  });

  it('canEdit is true for owner and for an edit-capable member', async () => {
    const owner = fakeSql({ facts: FACTS({ ownerId: 'u' }), isMember: false });
    expect(await canEditPageImpl(owner, 'u', 'p')).toBe(true);
    const member = fakeSql({ facts: FACTS(), isMember: true });
    expect(await canEditPageImpl(member, 'u', 'p')).toBe(true);
  });

  it('canAccess + canEdit are false with no role at all', async () => {
    const sql = fakeSql({ facts: FACTS(), isMember: false });
    expect(await canAccessPageImpl(sql, 'u', 'p')).toBe(false);
    expect(await canEditPageImpl(sql, 'u', 'p')).toBe(false);
  });
});
