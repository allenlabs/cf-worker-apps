// Database discovery + inspection.  Both endpoints require a workspace
// row to be picked from `/v1/workspaces/list` first; we decrypt the
// stored token, hit Notion, and forward the response.

import type { Client as NotionSDK } from '@notionhq/client';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { decrypt, deriveKey } from '@shared/crypto';
import type { DB } from '@shared/db/client';
import { workspaces } from '@shared/db/schema';
import { inspectDatabase, listDatabases, makeNotionClient } from '@shared/notion';
import { suggestMapping } from '@shared/mapping';
import {
  PM_FIELDS,
  type DatabaseInspectResponse,
  type NotionProperty,
} from '@shared/types';
import type { AppBindings } from '../context';
import type { Env } from '../env';
import { HandlerError } from './connections';

export interface ListDatabasesInput {
  workspace_id: number;
}
export const listDatabasesInput = z.object({ workspace_id: z.number().int().positive() });

export interface InspectDatabaseInput {
  workspace_id: number;
  database_id: string;
}
export const inspectDatabaseInput = z.object({
  workspace_id: z.number().int().positive(),
  database_id: z.string().min(1),
});

export interface DatabaseDeps {
  fetcher?: typeof fetch;
}

/**
 * Pull the workspace row, decrypt the token, return a Notion client
 * ready to hit the API.  Centralized so both handlers stay tiny.
 */
async function notionFor(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  workspaceId: number,
  deps: DatabaseDeps,
): Promise<NotionSDK> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) throw new HandlerError(404, 'workspace not found');
  const key = await deriveKey(env.WORKSPACE_TOKEN_KEY);
  const token = await decrypt(key, ws.accessToken);
  return makeNotionClient(token, { fetch: deps.fetcher });
}

export async function listDatabasesImpl(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  input: ListDatabasesInput,
  deps: DatabaseDeps = {},
): Promise<{ databases: Array<{ id: string; title: string }> }> {
  const client = await notionFor(db, env, input.workspace_id, deps);
  const databases = await listDatabases(client);
  return { databases };
}

export async function inspectDatabaseImpl(
  db: DB,
  env: Pick<Env, 'WORKSPACE_TOKEN_KEY'>,
  input: InspectDatabaseInput,
  deps: DatabaseDeps = {},
): Promise<DatabaseInspectResponse> {
  const client = await notionFor(db, env, input.workspace_id, deps);
  const info = await inspectDatabase(client, input.database_id);
  const suggested = suggestMapping(PM_FIELDS, info.properties);
  // Returned twice (`suggested` for back-compat with older callers, and
  // `suggested_mapping` for the documented wire shape consumers should
  // read).  Both reference the same object so the heuristic stays
  // single-source.
  return {
    database: info,
    suggested,
    suggested_mapping: suggested,
  };
}

/* v8 ignore start */
export const databasesRouter = new Hono<AppBindings>()
  .post('/list', async (c) => {
    const input = listDatabasesInput.parse(JSON.parse(c.var.rawBody || '{}'));
    try {
      return c.json(await listDatabasesImpl(c.var.db, c.env, input));
    } catch (err) {
      if (err instanceof HandlerError) {
        return c.json({ error: err.message }, err.status as 404);
      }
      throw err;
    }
  })
  .post('/inspect', async (c) => {
    const input = inspectDatabaseInput.parse(JSON.parse(c.var.rawBody || '{}'));
    try {
      return c.json(await inspectDatabaseImpl(c.var.db, c.env, input));
    } catch (err) {
      if (err instanceof HandlerError) {
        return c.json({ error: err.message }, err.status as 404);
      }
      throw err;
    }
  });
/* v8 ignore stop */
