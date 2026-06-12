import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  ForbiddenError,
  UnauthorizedError,
  hasPermission,
  permissionsForTeamRole,
  type AuthContext,
  type Permission,
} from '../../src/lib/permissions';

function makeCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 1,
    isAdmin: false,
    permissionsByProject: {},
    ...overrides,
  };
}

describe('hasPermission', () => {
  it('grants any permission to admins', () => {
    const ctx = makeCtx({ isAdmin: true });
    expect(hasPermission(ctx, 99, 'delete_project')).toBe(true);
  });

  it('grants per-project permission when set', () => {
    const ctx = makeCtx({
      permissionsByProject: { 1: new Set(['view_issues', 'edit_issues']) },
    });
    expect(hasPermission(ctx, 1, 'view_issues')).toBe(true);
    expect(hasPermission(ctx, 1, 'edit_issues')).toBe(true);
  });

  it('denies when permission missing for the project', () => {
    const ctx = makeCtx({
      permissionsByProject: { 1: new Set(['view_issues']) },
    });
    expect(hasPermission(ctx, 1, 'delete_issues')).toBe(false);
  });

  it('denies when the project is not in the context', () => {
    const ctx = makeCtx();
    expect(hasPermission(ctx, 42, 'view_project')).toBe(false);
  });
});

describe('error classes', () => {
  it('UnauthorizedError carries a name and default message', () => {
    const e = new UnauthorizedError();
    expect(e.name).toBe('UnauthorizedError');
    expect(e.message).toBe('Unauthorized');
  });

  it('UnauthorizedError accepts a custom message', () => {
    expect(new UnauthorizedError('no session').message).toBe('no session');
  });

  it('ForbiddenError carries a name and default message', () => {
    const e = new ForbiddenError();
    expect(e.name).toBe('ForbiddenError');
    expect(e.message).toBe('Forbidden');
  });

  it('ForbiddenError accepts a custom message', () => {
    expect(new ForbiddenError('admin only').message).toBe('admin only');
  });
});

describe('ALL_PERMISSIONS', () => {
  it('is a non-empty array of unique strings', () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(0);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('contains the well-known Redmine permissions', () => {
    const expected: Permission[] = [
      'view_project',
      'edit_project',
      'manage_members',
      'view_issues',
      'add_issues',
      'edit_issues',
      'delete_issues',
      'manage_wiki',
      'log_time',
      'view_gantt',
      'view_roadmap',
    ];
    for (const p of expected) expect(ALL_PERMISSIONS).toContain(p);
  });
});

describe('permissionsForTeamRole', () => {
  it('viewer + member get read-only access', () => {
    for (const role of ['viewer', 'member']) {
      const set = permissionsForTeamRole(role);
      expect(set.has('view_project')).toBe(true);
      expect(set.has('view_issues')).toBe(true);
      expect(set.has('add_issues')).toBe(false);
      expect(set.has('edit_project')).toBe(false);
      expect(set.has('manage_members')).toBe(false);
    }
  });

  it('commenter can add/edit issues but not edit the project', () => {
    const set = permissionsForTeamRole('commenter');
    expect(set.has('add_issues')).toBe(true);
    expect(set.has('edit_issues')).toBe(true);
    expect(set.has('add_issue_notes')).toBe(true);
    expect(set.has('edit_project')).toBe(false);
    expect(set.has('manage_wiki')).toBe(false);
  });

  it('contributor gains wiki/version/category but not project edit', () => {
    const set = permissionsForTeamRole('contributor');
    expect(set.has('manage_wiki')).toBe(true);
    expect(set.has('manage_versions')).toBe(true);
    expect(set.has('manage_categories')).toBe(true);
    expect(set.has('log_time')).toBe(true);
    expect(set.has('edit_project')).toBe(false);
    expect(set.has('manage_members')).toBe(false);
  });

  it('maintainer gains project edit but not delete/manage_members', () => {
    const set = permissionsForTeamRole('maintainer');
    expect(set.has('edit_project')).toBe(true);
    expect(set.has('delete_project')).toBe(false);
    expect(set.has('manage_members')).toBe(false);
  });

  it('owner and admin get the full permission set', () => {
    for (const role of ['owner', 'admin']) {
      const set = permissionsForTeamRole(role);
      expect(set.size).toBe(ALL_PERMISSIONS.length);
      expect(set.has('delete_project')).toBe(true);
      expect(set.has('manage_members')).toBe(true);
    }
  });

  it('unknown roles grant nothing', () => {
    expect(permissionsForTeamRole('bogus').size).toBe(0);
  });
});
