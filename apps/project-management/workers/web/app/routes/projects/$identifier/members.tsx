import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { displayName, formatDate, handle } from '@allenlabs/pm-core/lib/format';
import { notifyError, notifySuccess } from '~/lib/toast';
import { buildAuthContext, getCurrentUser, getDb, getEnv } from '~/server/auth-runtime.server';
import { inviteTeamMember, removeTeamMember, setTeamMemberRole } from '~/server/members';
import { loadTeamMembersImpl, TEAM_ROLE_OPTIONS } from '@allenlabs/pm-core/server/members';
import { getProjectImpl } from '@allenlabs/pm-core/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadMembers = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const team = await loadTeamMembersImpl(db, getEnv(), project.id);
    // Whether the viewer can manage members governs which controls render.
    const canManage =
      !!me?.isAdmin || !!ctx?.permissionsByProject[project.id]?.has('manage_members');
    return { team, canManage };
  });

export const Route = createFileRoute('/projects/$identifier/members')({
  loader: ({ params }) => loadMembers({ data: { identifier: params.identifier } }),
  component: MembersPage,
});

const ROLE_KEYS: Record<string, string> = {
  viewer: 'role.viewer',
  commenter: 'role.commenter',
  contributor: 'role.contributor',
  maintainer: 'role.maintainer',
  owner: 'role.owner',
  admin: 'role.admin',
  member: 'role.member',
};

function MembersPage() {
  const project = parentRoute.useLoaderData();
  const { team, canManage } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const roleLabel = (r: string) => (ROLE_KEYS[r] ? t(ROLE_KEYS[r]) : r);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const [busy, setBusy] = useState(false);

  async function invite() {
    if (!email) return;
    setBusy(true);
    try {
      await inviteTeamMember({ data: { projectId: project.id, email, role } });
      setEmail('');
      notifySuccess(t('members.inviteSent', { email }));
      router.invalidate();
    } catch (err) {
      notifyError(t('members.inviteError', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(targetUserId: string, newRole: string) {
    try {
      await setTeamMemberRole({ data: { projectId: project.id, targetUserId, role: newRole } });
      notifySuccess(t('members.roleUpdated'));
      router.invalidate();
    } catch (err) {
      notifyError(t('members.roleUpdateError', { msg: err instanceof Error ? err.message : String(err) }));
    }
  }

  async function remove(targetUserId: string) {
    if (!confirm(t('members.removeConfirm'))) return;
    try {
      await removeTeamMember({ data: { projectId: project.id, targetUserId } });
      notifySuccess(t('members.memberRemoved'));
      router.invalidate();
    } catch (err) {
      notifyError(t('members.removeError', { msg: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (!team.teamId) {
    return (
      <div className="space-y-4">
        <header><h2 className="text-xl font-semibold">{t('members.title')}</h2></header>
        <p className="text-sm text-gray-500">
          {t('members.notLinked')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header><h2 className="text-xl font-semibold">{t('members.title')}</h2></header>

      {canManage && (
        <div className="card p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[14rem]">
            <label className="label">{t('members.inviteByEmail')}</label>
            <input
              className="select"
              type="email"
              placeholder={t('members.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label">{t('members.role')}</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              {TEAM_ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </div>
          <button className="btn-primary" onClick={invite} disabled={!email || busy}>
            {t('members.sendInvite')}
          </button>
        </div>
      )}

      {team.members.length === 0 ? (
        <p className="text-sm text-gray-500">{t('members.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead>
            <tr><th>{t('members.colMember')}</th><th>{t('members.colEmail')}</th><th>{t('members.colRole')}</th>{canManage && <th></th>}</tr>
          </thead>
          <tbody>
            {team.members.map((m) => {
              const name = displayName(m);
              const h = handle(m.username);
              return (
                <tr key={m.userId}>
                  <td>
                    {name}
                    {h && <span className="text-xs text-gray-400 ml-1">{h}</span>}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {canManage ? (
                      <select
                        className="select w-40"
                        value={m.role}
                        onChange={(e) => changeRole(m.userId, e.target.value)}
                      >
                        {TEAM_ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>{roleLabel(r)}</option>
                        ))}
                      </select>
                    ) : (
                      roleLabel(m.role)
                    )}
                  </td>
                  {canManage && (
                    <td>
                      <button className="btn-danger" onClick={() => remove(m.userId)}>
                        {t('members.remove')}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {team.invitations.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">{t('members.pendingInvitations')}</h3>
          <table className="data-table card">
            <thead>
              <tr><th>{t('members.colEmail')}</th><th>{t('members.colRole')}</th><th>{t('members.colExpires')}</th></tr>
            </thead>
            <tbody>
              {team.invitations.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{inv.role ? roleLabel(inv.role) : '—'}</td>
                  <td>{formatDate(inv.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
