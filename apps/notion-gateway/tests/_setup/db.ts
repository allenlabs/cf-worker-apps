import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '@shared/db/client';
import * as schema from '@shared/db/schema';

// Mirror PM's pattern: surface the production `DB` type so handler
// impls (typed via the postgres-js driver) accept the PGlite-backed
// instance without per-call casts.  Drizzle's PG dialect is identical
// across drivers at runtime; the cast is purely to satisfy TS's HKT
// branding.
export type TestDB = DB;

const ROOT = join(__dirname, '..', '..');
const MIGRATION_RAW = readFileSync(join(ROOT, 'drizzle-pg', '0001_initial.sql'), 'utf8');
const MIGRATION_0002_RAW = readFileSync(
  join(ROOT, 'drizzle-pg', '0002_webhooks.sql'),
  'utf8',
);

/**
 * Strip Postgres-server-only features that PGlite (the in-memory
 * driver) doesn't bundle by default.  The production migration runs
 * unchanged against Hetzner.
 *
 *   - `CREATE EXTENSION ... pgcrypto` — used only for the seed
 *     `gen_random_bytes()` call; we replace the seed with a static
 *     placeholder secret since tests don't depend on it.
 */
const MIGRATION = MIGRATION_RAW
  .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;?/i, '')
  // Drop the seed INSERT entirely — tests insert their own app_clients
  // rows; the seeded `pm` row would otherwise collide on the unique
  // `client_id` index.
  .replace(/INSERT INTO notion_gateway\.app_clients[\s\S]*?ON CONFLICT \(client_id\) DO NOTHING;/i, '');

export async function makeTestDb(): Promise<TestDB> {
  const pglite = new PGlite();
  await pglite.exec(MIGRATION);
  await pglite.exec(MIGRATION_0002_RAW);
  // The migration sets search_path inline but it scopes to the
  // executing session.  Re-pin it on the live connection so subsequent
  // helper inserts resolve unqualified table names too.
  await pglite.exec(`SET search_path = notion_gateway, public;`);
  return drizzle(pglite, { schema }) as unknown as TestDB;
}

// ---------- helpers ----------

export async function insertAppClient(
  db: TestDB,
  fields: Partial<typeof schema.appClients.$inferInsert> = {},
): Promise<typeof schema.appClients.$inferSelect> {
  const [row] = await db
    .insert(schema.appClients)
    .values({
      clientId: fields.clientId ?? `client-${Math.random().toString(36).slice(2, 8)}`,
      name: fields.name ?? 'Test Client',
      hmacSecret: fields.hmacSecret ?? 'test-secret',
      allowedReturnOrigins: fields.allowedReturnOrigins ?? ['https://test.example'],
      ...fields,
    })
    .returning();
  if (!row) throw new Error('insertAppClient returned no row');
  return row;
}

export async function insertWorkspace(
  db: TestDB,
  fields: Partial<typeof schema.workspaces.$inferInsert> = {},
): Promise<typeof schema.workspaces.$inferSelect> {
  const [row] = await db
    .insert(schema.workspaces)
    .values({
      notionId: fields.notionId ?? `notion-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: fields.workspaceId ?? 'ws-uuid',
      name: fields.name ?? 'Test Workspace',
      icon: fields.icon ?? null,
      ownerEmail: fields.ownerEmail ?? 'owner@example.com',
      accessToken: fields.accessToken ?? 'ENCRYPTED_TOKEN',
      ...fields,
    })
    .returning();
  if (!row) throw new Error('insertWorkspace returned no row');
  return row;
}

export async function insertConnection(
  db: TestDB,
  fields: {
    appClientId: number;
    workspaceId: number;
    appResource: string;
    databaseId?: string;
    databaseTitle?: string;
    mapping?: Parameters<typeof db.insert<typeof schema.connections>>[0] extends never ? never : import('@shared/types').NotionMapping;
  } & Partial<typeof schema.connections.$inferInsert>,
): Promise<typeof schema.connections.$inferSelect> {
  const [row] = await db
    .insert(schema.connections)
    .values({
      appClientId: fields.appClientId,
      workspaceId: fields.workspaceId,
      appResource: fields.appResource,
      databaseId: fields.databaseId ?? 'db-id',
      databaseTitle: fields.databaseTitle ?? 'Test DB',
      mapping: fields.mapping ?? { fields: {} },
    })
    .returning();
  if (!row) throw new Error('insertConnection returned no row');
  return row;
}
