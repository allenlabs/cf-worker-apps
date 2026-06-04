import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DB } from '~/db/client';
import * as schema from '~/db/schema';
import { deriveProjectKey } from '~/lib/format';

// We surface `DB` as the test database type so server impls (typed
// `PostgresJsDatabase<typeof schema>` via `~/db/client`) accept the PGlite-
// backed instance without per-call casts. At runtime drizzle's PG dialect is
// identical across drivers; the cast is purely to satisfy TS's HKT branding.
export type TestDB = DB;

// Same path on disk for both the migration and the seed; we load them once
// and execute them inside a fresh in-memory Postgres (PGlite) per test run.
const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'drizzle-pg', '0001_initial.sql'), 'utf8');
const SEED = readFileSync(join(ROOT, 'drizzle-pg', '0002_seed.sql'), 'utf8');
// Notion tables were created in 0003 and dropped in 0004.  The forward
// migration history is applied verbatim so the test DB ends in the same
// state production will after the drop migration runs.
const NOTION_MIGRATION = readFileSync(join(ROOT, 'drizzle-pg', '0003_notion.sql'), 'utf8');
const NOTION_DROP_MIGRATION = readFileSync(
  join(ROOT, 'drizzle-pg', '0004_drop_notion.sql'),
  'utf8',
);
// Phase 2: projects.auth_team_id + users.username/preferred_name. The backfill
// UPDATEs in this file target specific prod identifiers/user-ids that don't
// exist in a fresh test DB, so they no-op harmlessly.
const PHASE2_MIGRATION = readFileSync(
  join(ROOT, 'drizzle-pg', '0005_pm_phase2.sql'),
  'utf8',
);
// Phase 3a: Jira-style issue keys (projects.key/issue_seq + issues.number).
const ISSUE_KEYS_MIGRATION = readFileSync(
  join(ROOT, 'drizzle-pg', '0006_issue_keys.sql'),
  'utf8',
);

export async function makeTestDb(opts?: { seed?: boolean }): Promise<TestDB> {
  const pglite = new PGlite();
  await pglite.exec(MIGRATION);
  await pglite.exec(NOTION_MIGRATION);
  await pglite.exec(NOTION_DROP_MIGRATION);
  await pglite.exec(PHASE2_MIGRATION);
  await pglite.exec(ISSUE_KEYS_MIGRATION);
  if (opts?.seed !== false) await pglite.exec(SEED);
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
