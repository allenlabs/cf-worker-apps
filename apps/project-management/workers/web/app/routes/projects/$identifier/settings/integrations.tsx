import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { useState } from 'react';
import { z } from 'zod';
import { issues, issueStatuses } from '~/db/schema';
import { PM_FIELDS } from '@cf-worker-apps/notion-gateway/shared/src/types';
import { useT } from '@allenlabs/i18n/react';
import { notifyError, notifySuccess } from '~/lib/toast';
import { getDb, getEnv, requirePermission } from '~/server/auth-runtime.server';
import * as notionGateway from '~/server/notion-gateway-client';
import type {
  DatabaseInspectResponse,
  GatewayConnection,
  NotionMapping,
} from '~/server/notion-gateway-client';

// ---------- Server functions (HMAC secret stays server-side) ----------
//
// Each helper takes the projectId for permission gating + a few opaque
// args; the gateway client wraps the HMAC-signed POST.  We DON'T return
// anything that includes secrets — only the gateway's response shapes.

const startOAuth = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ projectId: z.number(), returnTo: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.getOAuthStartUrl(env, {
      app_resource: `project/${data.projectId}`,
      return_to: data.returnTo,
    });
  });

const getConnectionFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.getConnection(env, {
      app_resource: `project/${data.projectId}`,
    });
  });

const listDatabasesFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ projectId: z.number(), workspaceId: z.number() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.listDatabases(env, { workspace_id: data.workspaceId });
  });

const inspectDatabaseFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        projectId: z.number(),
        workspaceId: z.number(),
        databaseId: z.string(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.inspectDatabase(env, {
      workspace_id: data.workspaceId,
      database_id: data.databaseId,
    });
  });

const upsertConnectionFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        projectId: z.number(),
        workspaceId: z.number(),
        databaseId: z.string(),
        databaseTitle: z.string(),
        mapping: z.any(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.upsertConnection(env, {
      app_resource: `project/${data.projectId}`,
      workspace_id: data.workspaceId,
      database_id: data.databaseId,
      database_title: data.databaseTitle,
      mapping: data.mapping as NotionMapping,
    });
  });

const disconnectFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    return notionGateway.disconnectConnection(env, {
      app_resource: `project/${data.projectId}`,
    });
  });

const resyncFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_project');
    const env = getEnv();
    const db = getDb(env);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
      .where(eq(issues.projectId, data.projectId));
    let synced = 0;
    for (const { id } of rows) {
      const fields = await notionGateway.loadIssueFields(db, id);
      /* v8 ignore next — issue-deletion race only; resync loop is best-effort. */
      if (!fields) continue;
      const { projectId, ...payload } = fields;
      try {
        await notionGateway.pushPage(env, {
          app_resource: `project/${projectId}`,
          app_record: `issue/${id}`,
          fields: payload as unknown as Record<string, unknown>,
        });
        synced++;
      } catch (err) {
        /* v8 ignore next 3 — per-page failures don't abort the resync; we
           keep going so a single broken row doesn't strand the rest. */
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[notion resync]', id, msg);
      }
    }
    return { synced, total: rows.length };
  });

// ---------- Route ----------

const parentRoute = getRouteApi('/projects/$identifier');

const SearchSchema = z.object({
  notion_connected: z.string().optional(),
  notion_workspace_id: z.string().optional(),
});

export const Route = createFileRoute('/projects/$identifier/settings/integrations')({
  validateSearch: SearchSchema,
  component: IntegrationsPage,
});

interface ConnectionStateNone {
  kind: 'none';
}
interface ConnectionStatePicking {
  kind: 'picking';
  workspaceId: number;
  databases: Array<{ id: string; title: string }>;
}
interface ConnectionStateMapping {
  kind: 'mapping';
  workspaceId: number;
  databaseId: string;
  databaseTitle: string;
  properties: DatabaseInspectResponse['database']['properties'];
  mapping: NotionMapping;
}
type LocalState = ConnectionStateNone | ConnectionStatePicking | ConnectionStateMapping;

function IntegrationsPage() {
  const project = parentRoute.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const { t } = useT();
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<GatewayConnection | null>(null);
  const [state, setState] = useState<LocalState>({ kind: 'none' });
  const [busy, setBusy] = useState(false);

  // Lazy first-render fetch.  After OAuth round-trip the user lands back
  // with `?notion_workspace_id=N` set; we auto-advance into the picker.
  if (!loaded) {
    setLoaded(true);
    void (async () => {
      try {
        const result = await getConnectionFn({ data: { projectId: project.id } });
        if (result.connection) {
          setConnection(result.connection);
          return;
        }
        if (search.notion_workspace_id) {
          const workspaceId = Number(search.notion_workspace_id);
          if (Number.isFinite(workspaceId)) {
            const dbs = await listDatabasesFn({
              data: { projectId: project.id, workspaceId },
            });
            setState({ kind: 'picking', workspaceId, databases: dbs.databases });
          }
        }
      } catch (e) {
        notifyError(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  async function startConnect() {
    setBusy(true);
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}`;
      const { start_url } = await startOAuth({
        data: { projectId: project.id, returnTo },
      });
      window.location.href = start_url;
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function pickDatabase(databaseId: string, databaseTitle: string) {
    if (state.kind !== 'picking') return;
    setBusy(true);
    try {
      const info = await inspectDatabaseFn({
        data: {
          projectId: project.id,
          workspaceId: state.workspaceId,
          databaseId,
        },
      });
      setState({
        kind: 'mapping',
        workspaceId: state.workspaceId,
        databaseId,
        databaseTitle: info.database.title || databaseTitle,
        properties: info.database.properties,
        mapping: info.suggested_mapping,
      });
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveMapping() {
    if (state.kind !== 'mapping') return;
    setBusy(true);
    try {
      await upsertConnectionFn({
        data: {
          projectId: project.id,
          workspaceId: state.workspaceId,
          databaseId: state.databaseId,
          databaseTitle: state.databaseTitle,
          mapping: state.mapping,
        },
      });
      notifySuccess(t('notion.connectedToast'));
      router.invalidate();
      setLoaded(false);
      setState({ kind: 'none' });
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm(t('notion.disconnectConfirm'))) return;
    setBusy(true);
    try {
      await disconnectFn({ data: { projectId: project.id } });
      notifySuccess(t('notion.disconnectedToast'));
      setConnection(null);
      router.invalidate();
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resync() {
    setBusy(true);
    try {
      const result = await resyncFn({ data: { projectId: project.id } });
      notifySuccess(t('notion.syncedToast', { synced: result.synced, total: result.total }));
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (connection) {
    return (
      <div className="max-w-2xl space-y-4">
        <h2 className="text-xl font-semibold">{t('notion.title')}</h2>
        <div className="card p-4">
          <p className="text-sm">
            {t('notion.connectedTo', { title: connection.database_title })}
          </p>
          <p className="text-xs text-gray-500 mt-1 font-mono">{connection.database_id}</p>
          <div className="flex gap-2 mt-3">
            <button className="btn-primary" disabled={busy} onClick={resync}>
              {t('notion.resyncAll')}
            </button>
            <button className="btn-danger" disabled={busy} onClick={disconnect}>
              {t('notion.disconnect')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'picking') {
    return (
      <div className="max-w-2xl space-y-4">
        <h2 className="text-xl font-semibold">{t('notion.pickDatabase')}</h2>
        {state.databases.length === 0 ? (
          <p className="text-sm text-gray-600">
            {t('notion.noDatabases')}
          </p>
        ) : (
          <ul className="card divide-y">
            {state.databases.map((d) => (
              <li key={d.id} className="p-3 flex items-center justify-between">
                <div>
                  <p className="font-medium">{d.title}</p>
                  <p className="font-mono text-xs text-gray-500">{d.id}</p>
                </div>
                <button
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => pickDatabase(d.id, d.title)}
                >
                  {t('btn.select')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (state.kind === 'mapping') {
    const propsList = Object.values(state.properties);
    return (
      <div className="max-w-3xl space-y-4">
        <h2 className="text-xl font-semibold">{t('notion.mapTitle', { title: state.databaseTitle })}</h2>
        <table className="data-table card">
          <thead>
            <tr>
              <th>{t('notion.colPmField')}</th>
              <th>{t('notion.colNotionProperty')}</th>
            </tr>
          </thead>
          <tbody>
            {PM_FIELDS.map((f) => {
              const current = state.mapping.fields[f.key];
              const compatible = propsList.filter((p) =>
                f.compatibleTypes.includes(p.type),
              );
              return (
                <tr key={f.key}>
                  <td>
                    <div className="font-medium">{f.label}</div>
                    <div className="text-xs text-gray-500">
                      {t('notion.accepts', { types: f.compatibleTypes.join(', ') })}
                    </div>
                  </td>
                  <td>
                    <select
                      className="select"
                      value={current?.propertyId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value;
                        const next: NotionMapping = {
                          fields: { ...state.mapping.fields },
                        };
                        if (!id) {
                          next.fields[f.key] = null;
                        } else {
                          const p = propsList.find((p) => p.id === id);
                          next.fields[f.key] = p
                            ? {
                                propertyId: p.id,
                                propertyName: p.name,
                                propertyType: p.type,
                              }
                            : null;
                        }
                        setState({ ...state, mapping: next });
                      }}
                    >
                      <option value="">—</option>
                      {compatible.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.type})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy} onClick={saveMapping}>
            {t('notion.saveMapping')}
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => setState({ kind: 'none' })}
          >
            {t('btn.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-xl font-semibold">{t('notion.title')}</h2>
      <div className="card p-4">
        <p className="text-sm text-gray-700">
          {t('notion.intro', { host: 'notion-api.allen.company' })}
        </p>
        <button className="btn-primary mt-3" disabled={busy} onClick={startConnect}>
          {t('notion.connectDatabase')}
        </button>
      </div>
    </div>
  );
}
