// Page upsert + archive.  The gateway is the only thing in the whole
// codebase that talks Notion HTTP at write time — consumer apps just
// post `{ app_resource, app_record, fields }` and the gateway figures
// out create-vs-update from the `page_links` table.

import type { Client as NotionSDK } from '@notionhq/client';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { decrypt, deriveKey } from '@shared/crypto';
import type { DB } from '@shared/db/client';
import { connections, pageLinks, workspaces } from '@shared/db/schema';
import { buildProperties } from '@shared/mapping';
import {
  archivePage,
  createPage,
  findUserByEmail,
  makeNotionClient,
  updatePage,
} from '@shared/notion';
import { PM_FIELDS } from '@shared/types';
import type { AppBindings } from '../context';
import type { Env } from '../env';
import { HandlerError } from './connections';

export const upsertPageInput = z.object({
  app_resource: z.string().min(1),
  app_record: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
});
export type UpsertPageInput = z.infer<typeof upsertPageInput>;

export const deletePageInput = z.object({
  app_resource: z.string().min(1),
  app_record: z.string().min(1),
});
export type DeletePageInput = z.infer<typeof deletePageInput>;

export interface PageDeps {
  fetcher?: typeof fetch;
}

/**
 * Resolve the (connection row, decrypted notion client) pair for an
 * app_resource.  Used by both upsert and delete so the loading logic
 * stays single-source.
 */
async function loadConnectionContext(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  appClientId: number,
  appResource: string,
  deps: PageDeps,
): Promise<{
  connection: typeof connections.$inferSelect;
  client: NotionSDK;
}> {
  const conn = await db.query.connections.findFirst({
    where: and(
      eq(connections.appClientId, appClientId),
      eq(connections.appResource, appResource),
    ),
  });
  if (!conn) throw new HandlerError(404, 'connection not found');
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, conn.workspaceId),
  });
  /* v8 ignore next — FK constraint guarantees ws exists. */
  if (!ws) throw new HandlerError(404, 'workspace not found');
  const key = await deriveKey(env.WORKSPACE_TOKEN_KEY);
  const token = await decrypt(key, ws.accessToken);
  return {
    connection: conn,
    client: makeNotionClient(token, { fetch: deps.fetcher }),
  };
}

export async function upsertPageImpl(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  appClientId: number,
  input: UpsertPageInput,
  deps: PageDeps = {},
): Promise<{ page_id: string; created: boolean }> {
  const { connection, client } = await loadConnectionContext(
    db,
    env,
    appClientId,
    input.app_resource,
    deps,
  );

  const properties = await buildProperties(PM_FIELDS, input.fields, connection.mapping, {
    resolvePersonId: (email: string) => findUserByEmail(client, email),
  });

  const existing = await db.query.pageLinks.findFirst({
    where: and(
      eq(pageLinks.connectionId, connection.id),
      eq(pageLinks.appRecord, input.app_record),
    ),
  });

  if (existing) {
    await updatePage(client, existing.pageId, properties);
    await db
      .update(pageLinks)
      .set({ syncedAt: new Date() })
      .where(
        and(
          eq(pageLinks.connectionId, connection.id),
          eq(pageLinks.appRecord, input.app_record),
        ),
      );
    return { page_id: existing.pageId, created: false };
  }

  const created = await createPage(client, connection.databaseId, properties);
  await db
    .insert(pageLinks)
    .values({
      connectionId: connection.id,
      appRecord: input.app_record,
      pageId: created.id,
    })
    .onConflictDoNothing();
  return { page_id: created.id, created: true };
}

export async function deletePageImpl(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  appClientId: number,
  input: DeletePageInput,
  deps: PageDeps = {},
): Promise<{ ok: true; archived: boolean }> {
  const { connection, client } = await loadConnectionContext(
    db,
    env,
    appClientId,
    input.app_resource,
    deps,
  );
  const link = await db.query.pageLinks.findFirst({
    where: and(
      eq(pageLinks.connectionId, connection.id),
      eq(pageLinks.appRecord, input.app_record),
    ),
  });
  if (!link) return { ok: true, archived: false };
  await archivePage(client, link.pageId);
  await db
    .delete(pageLinks)
    .where(
      and(
        eq(pageLinks.connectionId, connection.id),
        eq(pageLinks.appRecord, input.app_record),
      ),
    );
  return { ok: true, archived: true };
}

/* v8 ignore start */
export const pagesRouter = new Hono<AppBindings>()
  .post('/upsert', async (c) => {
    const input = upsertPageInput.parse(JSON.parse(c.var.rawBody || '{}'));
    try {
      return c.json(await upsertPageImpl(c.var.db, c.env, c.var.appClient.id, input));
    } catch (err) {
      if (err instanceof HandlerError) {
        return c.json({ error: err.message }, err.status as 404);
      }
      throw err;
    }
  })
  .post('/delete', async (c) => {
    const input = deletePageInput.parse(JSON.parse(c.var.rawBody || '{}'));
    try {
      return c.json(await deletePageImpl(c.var.db, c.env, c.var.appClient.id, input));
    } catch (err) {
      if (err instanceof HandlerError) {
        return c.json({ error: err.message }, err.status as 404);
      }
      throw err;
    }
  });
/* v8 ignore stop */
