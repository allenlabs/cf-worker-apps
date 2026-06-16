// Shared in-memory (PGlite) test database for the PM suite. pm-core owns the
// schema and the migration ledger, so it also owns the harness that builds a
// test DB from those exact migrations — guaranteeing "test DB == prod schema"
// for every consumer (the allenlabs app, a private tenant app, pm-core's own
// unit tests). Apps re-export this from their `tests/_setup/db` so existing
// test imports don't change.

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type DB } from '../db/client';
import * as schema from '../db/schema';
import { deriveProjectKey } from '../lib/format';

// We surface `DB` as the test database type so server impls (typed
// `PostgresJsDatabase<typeof schema>` via db/client) accept the PGlite-backed
// instance without per-call casts. At runtime drizzle's PG dialect is identical
// across drivers; the cast is purely to satisfy TS's HKT branding.
export type TestDB = DB;

/** Read a migration/seed file from pm-core's `drizzle-pg/` ledger. */
function sql(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../drizzle-pg/${name}`, import.meta.url)), 'utf8');
}

// The forward migration history, applied verbatim so the test DB ends in the
// same state production reaches after each migration runs (including the
// notion tables that 0003 created and 0004 dropped). The backfill UPDATEs in
// 0005 target specific prod identifiers/user-ids that don't exist in a fresh
// test DB, so they no-op harmlessly.
const MIGRATIONS = [
  '0001_initial.sql',
  '0003_notion.sql',
  '0004_drop_notion.sql',
  '0005_pm_phase2.sql',
  '0006_issue_keys.sql',
  '0007_issue_labels.sql',
  '0008_issue_relations.sql',
  '0009_fts.sql',
  '0010_notifications.sql',
  '0011_api_clients.sql',
  '0012_groups.sql',
  '0013_sites.sql',
];

export async function makeTestDb(opts?: { seed?: boolean }): Promise<TestDB> {
  const pglite = new PGlite();
  for (const m of MIGRATIONS) await pglite.exec(sql(m));
  if (opts?.seed !== false) await pglite.exec(sql('0002_seed.sql'));
  // The migration sets search_path inline, but it scopes to the session that
  // executed the DDL. Re-pin it on the live connection so helper inserts
  // resolve unqualified `pm.*` names too.
  await pglite.exec(`SET search_path = pm, public;`);
  return drizzle(pglite, { schema }) as unknown as TestDB;
}

// A few high-level helpers tests reach for so they stay terse.

export async function insertUser(
  db: TestDB,
  fields: Partial<typeof schema.users.$inferInsert> = {},
): Promise<typeof schema.users.$inferSelect> {
  const [user] = await db
    .insert(schema.users)
    .values({
      login: fields.login ?? 'tester',
      email: fields.email ?? 'tester@example.com',
      firstname: fields.firstname ?? 'Test',
      lastname: fields.lastname ?? 'User',
      admin: fields.admin ?? false,
      status: fields.status ?? 'active',
      ...fields,
    })
    .returning();
  if (!user) throw new Error('insertUser returned no row');
  return user;
}

export async function insertProject(
  db: TestDB,
  fields: Partial<typeof schema.projects.$inferInsert> = {},
): Promise<typeof schema.projects.$inferSelect> {
  const identifier = fields.identifier ?? 'demo';
  const [p] = await db
    .insert(schema.projects)
    .values({
      identifier,
      key: fields.key ?? deriveProjectKey(identifier),
      name: fields.name ?? 'Demo',
      description: fields.description ?? '',
      isPublic: fields.isPublic ?? false,
      ...fields,
    })
    .returning();
  if (!p) throw new Error('insertProject returned no row');
  // enable all default trackers
  const trackers = await db.select().from(schema.trackers);
  if (trackers.length > 0) {
    await db
      .insert(schema.projectTrackers)
      .values(trackers.map((t) => ({ projectId: p.id, trackerId: t.id })));
  }
  // enable wiki shell so wiki tests don't blow up
  await db.insert(schema.wikis).values({ projectId: p.id }).onConflictDoNothing();
  return p;
}

export async function addManager(
  db: TestDB,
  userId: number,
  projectId: number,
): Promise<void> {
  const manager = await db.query.roles.findFirst({
    where: (r, { eq }) => eq(r.name, 'Manager'),
  });
  if (!manager) throw new Error('Manager role not seeded');
  await db.insert(schema.members).values({ userId, projectId, roleId: manager.id });
}
