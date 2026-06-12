export type Permission =
  | 'view_project'
  | 'edit_project'
  | 'close_project'
  | 'delete_project'
  | 'manage_members'
  | 'manage_versions'
  | 'manage_categories'
  | 'view_issues'
  | 'add_issues'
  | 'edit_issues'
  | 'delete_issues'
  | 'add_issue_notes'
  | 'manage_wiki'
  | 'edit_wiki_pages'
  | 'view_wiki_pages'
  | 'view_time_entries'
  | 'log_time'
  | 'edit_time_entries'
  | 'manage_files'
  | 'view_files'
  | 'view_gantt'
  | 'view_roadmap';

export const ALL_PERMISSIONS: Permission[] = [
  'view_project',
  'edit_project',
  'close_project',
  'delete_project',
  'manage_members',
  'manage_versions',
  'manage_categories',
  'view_issues',
  'add_issues',
  'edit_issues',
  'delete_issues',
  'add_issue_notes',
  'manage_wiki',
  'edit_wiki_pages',
  'view_wiki_pages',
  'view_time_entries',
  'log_time',
  'edit_time_entries',
  'manage_files',
  'view_files',
  'view_gantt',
  'view_roadmap',
];

export interface AuthContext {
  userId: number;
  isAdmin: boolean;
  permissionsByProject: Record<number, Set<Permission>>;
}

/**
 * Allen Labs access-control team/org roles, mirrored from the auth-api
 * definition (cf-worker-apps-private/apps/auth/workers/api/src/auth.ts). A PM
 * project ↔ a Better Auth team; the user's role on that team (carried in the
 * JWT `teamMemberships[].role`) maps to the PM `Permission` set below.
 *
 * Kept in lock-step with the auth-side AC roles:
 *   viewer       → project:view
 *   commenter    → + issue:create/edit  (= add/edit issues + notes)
 *   contributor  → + issue close/assign, wiki/version/category
 *   maintainer   → + project:edit, member:view
 *   owner/admin  → full incl. project:delete + manage_members
 *   member       → project:view (org default)
 */
export type TeamRole =
  | 'owner'
  | 'admin'
  | 'maintainer'
  | 'contributor'
  | 'commenter'
  | 'viewer'
  | 'member';

const VIEWER_PERMS: Permission[] = [
  'view_project',
  'view_issues',
  'view_wiki_pages',
  'view_files',
  'view_time_entries',
  'view_gantt',
  'view_roadmap',
];

const COMMENTER_PERMS: Permission[] = [
  ...VIEWER_PERMS,
  'add_issues',
  'edit_issues',
  'add_issue_notes',
];

const CONTRIBUTOR_PERMS: Permission[] = [
  ...COMMENTER_PERMS,
  'close_project',
  'manage_versions',
  'manage_categories',
  'manage_wiki',
  'edit_wiki_pages',
  'log_time',
  'edit_time_entries',
  'manage_files',
];

const MAINTAINER_PERMS: Permission[] = [...CONTRIBUTOR_PERMS, 'edit_project'];

// owner / admin get everything, including delete_project + manage_members.
const OWNER_PERMS: Permission[] = ALL_PERMISSIONS;

const TEAM_ROLE_PERMISSIONS: Record<TeamRole, Permission[]> = {
  viewer: VIEWER_PERMS,
  // org default `member` maps to read-only, same as viewer.
  member: VIEWER_PERMS,
  commenter: COMMENTER_PERMS,
  contributor: CONTRIBUTOR_PERMS,
  maintainer: MAINTAINER_PERMS,
  admin: OWNER_PERMS,
  owner: OWNER_PERMS,
};

/**
 * Resolve the PM permission set for a given team role. Unknown role strings
 * (defensive — should never happen given the auth-side enum) yield an empty
 * set so an unrecognized role can never silently grant access.
 */
export function permissionsForTeamRole(role: string): Set<Permission> {
  const perms = TEAM_ROLE_PERMISSIONS[role as TeamRole];
  return new Set(perms ?? []);
}

export function hasPermission(
  ctx: AuthContext,
  projectId: number,
  permission: Permission,
): boolean {
  if (ctx.isAdmin) return true;
  const set = ctx.permissionsByProject[projectId];
  return set?.has(permission) ?? false;
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
