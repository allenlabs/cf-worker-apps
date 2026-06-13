// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/members; this file binds the SSR runtime
// (getDb / getEnv / requirePermission / requireUser). Exercised by the wrangler
// integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  TEAM_ROLE_OPTIONS,
  addMemberImpl,
  changeMemberRoleImpl,
  inviteMemberImpl,
  listAllUsersImpl,
  listMembersImpl,
  listRolesImpl,
  loadTeamMembersImpl,
  removeMemberImpl,
  removeTeamMemberImpl,
  setTeamMemberRoleImpl,
} from '@allenlabs/pm-core/server/members';
import { getDb, getEnv, requirePermission, requireUser } from './auth-runtime.server';

export const listMembers = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => listMembersImpl(getDb(), data.projectId));

export const listAllUsers = createServerFn({ method: 'GET' }).handler(async () => {
  await requireUser();
  return listAllUsersImpl(getDb());
});

export const listRoles = createServerFn({ method: 'GET' }).handler(async () => {
  await requireUser();
  return listRolesImpl(getDb());
});

export const addMember = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({ projectId: z.number(), userId: z.number(), roleId: z.number() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_members');
    return addMemberImpl(getDb(), data);
  });

export const removeMember = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ memberId: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_members');
    return removeMemberImpl(getDb(), data.memberId);
  });

export const changeMemberRole = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({ memberId: z.number(), projectId: z.number(), roleId: z.number() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_members');
    return changeMemberRoleImpl(getDb(), data.memberId, data.roleId);
  });

// ---------- Phase 2: team-backed collaborators ----------

const teamRoleSchema = z.enum(TEAM_ROLE_OPTIONS);

export const loadTeamMembers = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    // Anyone who can view the members tab can see the roster.
    await requirePermission(data.projectId, 'view_project');
    return loadTeamMembersImpl(getDb(), getEnv(), data.projectId);
  });

export const inviteTeamMember = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({ projectId: z.number(), email: z.string().email(), role: teamRoleSchema })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { user } = await requirePermission(data.projectId, 'manage_members');
    if (!user.betterAuthUserId) throw new Error('Your account is missing its auth link.');
    return inviteMemberImpl(getDb(), getEnv(), {
      actingUserId: user.betterAuthUserId,
      projectId: data.projectId,
      email: data.email,
      role: data.role,
    });
  });

export const setTeamMemberRole = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({ projectId: z.number(), targetUserId: z.string(), role: teamRoleSchema })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { user } = await requirePermission(data.projectId, 'manage_members');
    if (!user.betterAuthUserId) throw new Error('Your account is missing its auth link.');
    return setTeamMemberRoleImpl(getDb(), getEnv(), {
      actingUserId: user.betterAuthUserId,
      projectId: data.projectId,
      targetUserId: data.targetUserId,
      role: data.role,
    });
  });

export const removeTeamMember = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ projectId: z.number(), targetUserId: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { user } = await requirePermission(data.projectId, 'manage_members');
    if (!user.betterAuthUserId) throw new Error('Your account is missing its auth link.');
    return removeTeamMemberImpl(getDb(), getEnv(), {
      actingUserId: user.betterAuthUserId,
      projectId: data.projectId,
      targetUserId: data.targetUserId,
    });
  });

/* v8 ignore stop */
