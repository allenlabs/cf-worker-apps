// Connection CRUD.  A "connection" is one (consumer-app, app-resource)
// pair pointing at a specific Notion Database in a specific workspace,
// with the field mapping snapshot frozen at connect-time.

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '@shared/db/client';
import { connections, workspaces } from '@shared/db/schema';
import type { NotionMapping } from '@shared/types';
import type { AppBindings } from '../context';

export interface ConnectionView {
  id: number;
  workspace_id: number;
  workspace_name: string;
  database_id: string;
  database_title: string;
  mapping: NotionMapping;
  created_at: string;
  updated_at: string;
}

function viewFromRow(
  row: typeof connections.$inferSelect,
  workspaceName: string,
): ConnectionView {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    workspace_name: workspaceName,
    database_id: row.databaseId,
    database_title: row.databaseTitle,
    mapping: row.mapping,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------- get ----------

export const getConnectionInput = z.object({ app_resource: z.string().min(1) });
export type GetConnectionInput = z.infer<typeof getConnectionInput>;

export async function getConnectionImpl(
  db: DB,
  appClientId: number,
  input: GetConnectionInput,
): Promise<{ connection: ConnectionView | null }> {
  const row = await db.query.connections.findFirst({
    where: and(
      eq(connections.appClientId, appClientId),
      eq(connections.appResource, input.app_resource),
    ),
  });
  if (!row) return { connection: null };
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
  /* v8 ignore next — FK constraint guarantees ws exists; defensive fallback. */
  return { connection: viewFromRow(row, ws?.name ?? '(missing)') };
}

// ---------- list ----------

export async function listConnectionsImpl(
  db: DB,
  appClientId: number,
): Promise<{ connections: ConnectionView[] }> {
  const rows = await db
    .select({
      conn: connections,
      workspaceName: workspaces.name,
    })
    .from(connections)
    .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
    .where(eq(connections.appClientId, appClientId));
  return {
    connections: rows.map((r) => viewFromRow(r.conn, r.workspaceName)),
  };
}

// ---------- upsert ----------

export const upsertConnectionInput = z.object({
  app_resource: z.string().min(1),
  workspace_id: z.number().int().positive().optional(),
  database_id: z.string().min(1),
  database_title: z.string().min(1),
  mapping: z.object({ fields: z.record(z.string(), z.unknown()) }).passthrough(),
});
export type UpsertConnectionInput = z.infer<typeof upsertConnectionInput>;

export async function upsertConnectionImpl(
  db: DB,
  appClientId: number,
  input: UpsertConnectionInput,
): Promise<{ connection: ConnectionView }> {
  const existing = await db.query.connections.findFirst({
    where: and(
      eq(connections.appClientId, appClientId),
      eq(connections.appResource, input.app_resource),
    ),
  });

  const workspaceId =
    input.workspace_id ?? existing?.workspaceId ?? null;
  if (workspaceId === null) {
    throw new HandlerError(400, 'workspace_id required for first connect');
  }

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!ws) throw new HandlerError(404, 'workspace not found');

  if (existing) {
    const [updated] = await db
      .update(connections)
      .set({
        workspaceId,
        databaseId: input.database_id,
        databaseTitle: input.database_title,
        mapping: input.mapping as unknown as NotionMapping,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, existing.id))
      .returning();
    /* v8 ignore next — RETURNING always populates `updated` after a row exists. */
    if (!updated) throw new HandlerError(500, 'failed to update connection');
    return { connection: viewFromRow(updated, ws.name) };
  }

  const [created] = await db
    .insert(connections)
    .values({
      appClientId,
      workspaceId,
      appResource: input.app_resource,
      databaseId: input.database_id,
      databaseTitle: input.database_title,
      mapping: input.mapping as unknown as NotionMapping,
    })
    .returning();
  /* v8 ignore next — RETURNING always populates `created` after a successful insert. */
  if (!created) throw new HandlerError(500, 'failed to insert connection');
  return { connection: viewFromRow(created, ws.name) };
}

// ---------- delete ----------

export const deleteConnectionInput = z.object({ app_resource: z.string().min(1) });
export type DeleteConnectionInput = z.infer<typeof deleteConnectionInput>;

export async function deleteConnectionImpl(
  db: DB,
  appClientId: number,
  input: DeleteConnectionInput,
): Promise<{ ok: true }> {
  await db
    .delete(connections)
    .where(
      and(
        eq(connections.appClientId, appClientId),
        eq(connections.appResource, input.app_resource),
      ),
    );
  return { ok: true };
}

// ---------- typed handler error ----------

export class HandlerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

/* v8 ignore start */
export const connectionsRouter = new Hono<AppBindings>()
  .post('/get', async (c) => {
    const input = getConnectionInput.parse(JSON.parse(c.var.rawBody || '{}'));
    return c.json(await getConnectionImpl(c.var.db, c.var.appClient.id, input));
  })
  .post('/list', async (c) => {
    return c.json(await listConnectionsImpl(c.var.db, c.var.appClient.id));
  })
  .post('/upsert', async (c) => {
    const input = upsertConnectionInput.parse(JSON.parse(c.var.rawBody || '{}'));
    try {
      return c.json(await upsertConnectionImpl(c.var.db, c.var.appClient.id, input));
    } catch (err) {
      if (err instanceof HandlerError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 500);
      }
      throw err;
    }
  })
  .post('/delete', async (c) => {
    const input = deleteConnectionInput.parse(JSON.parse(c.var.rawBody || '{}'));
    return c.json(await deleteConnectionImpl(c.var.db, c.var.appClient.id, input));
  });
/* v8 ignore stop */
