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

// ---- Group-tree role → permission mapping (0012 logical hierarchy) ----
//
// A user's effective permissions on a project are the UNION (most-permissive)
// of: the project-member role (legacy pm.members, authoritative when present)
// and the group roles the user holds on the project's group OR any of its
// ANCESTORS (membership inherits DOWN the tree). Groups are additive — a
// project with no group resolves from pm.members exactly as before.
//
// Precedence is moot because we union sets — a user gets every permission any
// applicable role grants. The role strength:
//   owner | admin → full project-manager perms across the whole subtree
//   lead          → full project-manager perms for its subtree
//   member        → contributor (create/edit issues, wiki, versions, time, …)
export type GroupRole = 'owner' | 'admin' | 'lead' | 'member';

const GROUP_ROLE_PERMISSIONS: Record<GroupRole, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  lead: ALL_PERMISSIONS,
  member: CONTRIBUTOR_PERMS,
};

/** PM permissions for a group_members role (unknown ⇒ none — fail-closed). */
export function permissionsForGroupRole(role: string): Set<Permission> {
  return new Set(GROUP_ROLE_PERMISSIONS[role as GroupRole] ?? []);
}

// ---- Site role → permission mapping (0013 top partition) ----
//
// A site is the TOP partition; it sits ABOVE the group tree. A site
// owner/admin manages EVERY project in the site (full project-manager perms);
// a plain site `member` only *belongs* to the site — it grants no broad
// project access on its own (project/group membership still applies). This is
// deliberately narrower than a group role: site membership is the partition
// boundary, not a blanket grant.
export type SiteRole = 'owner' | 'admin' | 'member';

const SITE_ROLE_PERMISSIONS: Record<SiteRole, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  member: [],
};

/** PM permissions for a site_members role (unknown/member ⇒ none — fail-closed). */
export function permissionsForSiteRole(role: string): Set<Permission> {
  return new Set(SITE_ROLE_PERMISSIONS[role as SiteRole] ?? []);
}

// Delegated site administration. Site roles form a rank: owner > admin > member.
const SITE_ROLE_RANK: Record<SiteRole, number> = { owner: 2, admin: 1, member: 0 };

/**
 * May an actor holding `actorRole` on a site assign `newRole` to (or remove) a
 * member who currently holds `currentRole`?
 *
 *   - Only owner/admin manage anyone (a plain `member` manages no one).
 *   - You may only act on members at or below your own rank — an admin cannot
 *     touch an owner; an owner may manage owners.
 *   - You may only grant a role at or below your own rank — an admin cannot mint
 *     an owner; an owner may grant owner. (So admin tops out at admin.)
 *
 * Pass `newRole = null` for a removal (only the current-role check applies), and
 * `currentRole = null` when the target is not yet a site member. A `null`
 * `actorRole` (the actor isn't a site member) can manage no one. This governs
 * DELEGATED grants only — a global service admin bypasses it (use the
 * unrestricted setSiteMemberRoleImpl / removeSiteMemberImpl).
 */
export function canManageSiteRole(
  actorRole: SiteRole | null,
  currentRole: SiteRole | null,
  newRole: SiteRole | null,
): boolean {
  if (actorRole == null) return false;
  const actorRank = SITE_ROLE_RANK[actorRole];
  if (actorRank < SITE_ROLE_RANK.admin) return false; // members manage no one
  if (currentRole != null && actorRank < SITE_ROLE_RANK[currentRole]) return false;
  if (newRole != null && actorRank < SITE_ROLE_RANK[newRole]) return false;
  return true;
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
