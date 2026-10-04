// Workspace listing + lookup.
//
// The gateway is the user's own — there's no per-app workspace
// isolation, so /v1/workspaces/list returns every workspace the gateway
// has been authorized for.  Future tightening (e.g. only return
// workspaces this client already has a connection in) would happen in
// `listWorkspacesImpl`.

import { Hono } from 'hono';
import type { DB } from '@shared/db/client';
import { workspaces } from '@shared/db/schema';
import type { AppBindings } from '../context';

export interface WorkspaceListItem {
  id: number;
  notion_id: string;
  name: string;
  icon: string | null;
  owner_email: string | null;
}

export async function listWorkspacesImpl(db: DB): Promise<WorkspaceListItem[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      notionId: workspaces.notionId,
      name: workspaces.name,
      icon: workspaces.icon,
      ownerEmail: workspaces.ownerEmail,
    })
    .from(workspaces)
    .orderBy(workspaces.id);
  return rows.map((r) => ({
    id: r.id,
    notion_id: r.notionId,
    name: r.name,
    icon: r.icon,
    owner_email: r.ownerEmail,
  }));
}

/* v8 ignore start */
export const workspacesRouter = new Hono<AppBindings>().post('/list', async (c) => {
  const list = await listWorkspacesImpl(c.var.db);
  return c.json({ workspaces: list });
});
/* v8 ignore stop */
