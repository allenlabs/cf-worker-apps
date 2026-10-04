import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '../db/client';
import { members, projects, roles, users } from '../db/schema';
import {
  inviteMember,
  listTeamMembers,
  removeMember as orgRemoveMember,
  setMemberRole as orgSetMemberRole,
  type OrgClientDeps,
  type TeamInvitation,
  type TeamMember,
} from './org-client';
import { getRefData } from './ref-data';
import type { Env } from '../lib/env';

type OrgEnv = Pick<Env, 'AUTH_API_URL' | 'PM_ORG_HMAC_CLIENT_ID' | 'PM_ORG_HMAC_SECRET'>;

/** AC team roles a PM member can be assigned, in ascending capability order. */
export const TEAM_ROLE_OPTIONS = [
  'viewer',
  'commenter',
  'contributor',
  'maintainer',
  'owner',
] as const;
export type TeamRoleOption = (typeof TEAM_ROLE_OPTIONS)[number];

/**
 * Resolve a project's backing Better Auth team id by PM project id. Returns
 * null when the project has no team yet (legacy projects pre-backfill).
 */
export async function teamIdForProjectImpl(db: DB, projectId: number): Promise<string | null> {
  const row = await db
    .select({ authTeamId: projects.authTeamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row[0]?.authTeamId ?? null;
}

export interface TeamMembersResult {
  teamId: string | null;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

/** Load the team roster + pending invites for a project's backing team. */
export async function loadTeamMembersImpl(
  db: DB,
  env: OrgEnv,
  projectId: number,
  deps?: OrgClientDeps,
): Promise<TeamMembersResult> {
  const teamId = await teamIdForProjectImpl(db, projectId);
  if (!teamId) return { teamId: null, members: [], invitations: [] };
  const { members, invitations } = await listTeamMembers(env, teamId, deps);
  return { teamId, members, invitations };
}

/** Invite a collaborator by email at the given AC role. */
export async function inviteMemberImpl(
  db: DB,
  env: OrgEnv,
  args: { actingUserId: string; projectId: number; email: string; role: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true; invitationId: string | null }> {
  const teamId = await teamIdForProjectImpl(db, args.projectId);
  if (!teamId) throw new Error('This project has no collaboration team yet.');
  const res = await inviteMember(
    env,
    { actingUserId: args.actingUserId, teamId, email: args.email, role: args.role },
    deps,
  );
  return { ok: true, invitationId: res.invitationId };
}

/** Change a team member's role. */
export async function setTeamMemberRoleImpl(
  db: DB,
  env: OrgEnv,
  args: { actingUserId: string; projectId: number; targetUserId: string; role: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true }> {
  const teamId = await teamIdForProjectImpl(db, args.projectId);
  if (!teamId) throw new Error('This project has no collaboration team yet.');
  await orgSetMemberRole(
    env,
    { actingUserId: args.actingUserId, teamId, targetUserId: args.targetUserId, role: args.role },
    deps,
  );
  return { ok: true };
}

/** Remove a team member. */
export async function removeTeamMemberImpl(
  db: DB,
  env: OrgEnv,
  args: { actingUserId: string; projectId: number; targetUserId: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true }> {
  const teamId = await teamIdForProjectImpl(db, args.projectId);
  if (!teamId) throw new Error('This project has no collaboration team yet.');
  await orgRemoveMember(
    env,
    { actingUserId: args.actingUserId, teamId, targetUserId: args.targetUserId },
    deps,
  );
  return { ok: true };
}

export async function listMembersImpl(db: DB, projectId: number) {
  return db
    .select({
      id: members.id,
      userId: users.id,
      login: users.login,
      firstname: users.firstname,
      lastname: users.lastname,
      email: users.email,
      avatarUrl: users.avatarUrl,
      roleId: roles.id,
      roleName: roles.name,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(roles, eq(roles.id, members.roleId))
    .where(eq(members.projectId, projectId))
    .orderBy(users.login);
}

export async function listAllUsersImpl(db: DB) {
  return db
    .select({
      id: users.id,
      login: users.login,
      firstname: users.firstname,
      lastname: users.lastname,
      email: users.email,
    })
    .from(users)
    .where(eq(users.status, 'active'))
    .orderBy(users.login);
}

export async function listRolesImpl(db: DB) {
  // Roles are global ref-data — pulled from the module-level cache.
  return (await getRefData(db)).roles;
}

export async function addMemberImpl(
  db: DB,
  data: { projectId: number; userId: number; roleId: number },
): Promise<{ ok: true }> {
  await db.insert(members).values(data).onConflictDoNothing();
  return { ok: true };
}

export async function removeMemberImpl(db: DB, memberId: number): Promise<{ ok: true }> {
  await db.delete(members).where(eq(members.id, memberId));
  return { ok: true };
}

export async function changeMemberRoleImpl(
  db: DB,
  memberId: number,
  roleId: number,
): Promise<{ ok: true }> {
  await db.update(members).set({ roleId }).where(eq(members.id, memberId));
  return { ok: true };
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
