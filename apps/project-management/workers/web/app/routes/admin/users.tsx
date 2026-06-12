import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { users } from '~/db/schema';
import { formatDateTime } from '@allenlabs/pm-core/lib/format';
import { notifyError, notifySuccess } from '~/lib/toast';
import { getDb, requireAdmin } from '~/server/auth-runtime.server';

const loadUsers = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin();
  const db = getDb();
  return db.query.users.findMany({ orderBy: users.login });
});

const setAdmin = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), admin: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getDb();
    await db.update(users).set({ admin: data.admin }).where(eq(users.id, data.id));
    return { ok: true };
  });

const setStatus = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.number(), status: z.enum(['active', 'locked']) }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = getDb();
    await db.update(users).set({ status: data.status }).where(eq(users.id, data.id));
    return { ok: true };
  });

export const Route = createFileRoute('/admin/users')({
  beforeLoad: async () => {
    // Server-only gate. `getCurrentUser` is a `*.server.*` helper that the
    // vite build replaces with an import-protection mock proxy in the client
    // bundle; `await`ing that mock never settles and would hang client-side
    // navigation to /admin/users. SSR already gated this route, so bail out
    // on the client. (See the long note in routes/__root.tsx.)
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const me = await getCurrentUser();
    if (!me?.isAdmin) throw redirect({ to: '/' });
  },
  loader: () => loadUsers(),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">{t('admin.usersTitle')}</h1>
      <table className="data-table card">
        <thead>
          <tr><th>{t('admin.colLogin')}</th><th>{t('admin.colEmail')}</th><th>{t('admin.colName')}</th><th>{t('admin.colAdmin')}</th><th>{t('admin.colStatus')}</th><th>{t('admin.colLastLogin')}</th><th>{t('admin.colCreated')}</th></tr>
        </thead>
        <tbody>
          {data.map((u) => (
            <tr key={u.id}>
              <td className="font-medium">{u.login}</td>
              <td>{u.email}</td>
              <td>{u.firstname} {u.lastname}</td>
              <td>
                <input
                  type="checkbox"
                  checked={u.admin}
                  onChange={async (e) => {
                    try {
                      await setAdmin({ data: { id: u.id, admin: e.target.checked } });
                      notifySuccess(t('admin.userUpdated'));
                      router.invalidate();
                    } catch (err) {
                      notifyError(t('admin.userUpdateError', { msg: err instanceof Error ? err.message : String(err) }));
                    }
                  }}
                />
              </td>
              <td>
                <select
                  className="select w-28"
                  value={u.status}
                  onChange={async (e) => {
                    try {
                      await setStatus({ data: { id: u.id, status: e.target.value as any } });
                      notifySuccess(t('admin.userUpdated'));
                      router.invalidate();
                    } catch (err) {
                      notifyError(t('admin.userUpdateError', { msg: err instanceof Error ? err.message : String(err) }));
                    }
                  }}
                >
                  <option value="active">{t('admin.statusActive')}</option>
                  <option value="locked">{t('admin.statusLocked')}</option>
                </select>
              </td>
              <td>{formatDateTime(u.lastLoginAt)}</td>
              <td>{formatDateTime(u.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
