import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { timeEntries } from '@allenlabs/pm-core/db/schema';
import { type CurrentUser } from '~/server/auth';
import {
  createTimeEntryImpl,
  deleteTimeEntryImpl,
  listActivitiesImpl,
  listTimeEntriesImpl,
} from '~/server/time-entries';

let db: TestDB;
let projectId: number;
let alice: CurrentUser;

beforeEach(async () => {
  db = await makeTestDb();
  const p = await insertProject(db);
  projectId = p.id;
  const u = await insertUser(db, { login: 'alice' });
  alice = {
    id: u.id,
    login: 'alice',
    email: u.email,
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
  };
});

describe('time entry impls', () => {
  it('listActivitiesImpl returns the seeded activities ordered by position', async () => {
    const acts = await listActivitiesImpl(db);
    expect(acts.map((a) => a.name)).toEqual(['Design', 'Development', 'Testing', 'Support']);
  });

  it('createTimeEntryImpl writes entry and activity log', async () => {
    const e = await createTimeEntryImpl(db, alice, {
      projectId,
      activityId: 2,
      hours: 1.5,
      comments: 'wired the form',
      spentOn: '2026-05-21',
    });
    expect(e.hours).toBe(1.5);
    const acts = await db.query.activities.findMany();
    const tl = acts.find((a) => a.kind === 'time_logged');
    expect(tl?.title).toContain('1.5');
  });

  it('createTimeEntryImpl mentions issueId in activity title when set', async () => {
    const { issues } = await import('@allenlabs/pm-core/db/schema');
    const [issue] = await db
      .insert(issues)
      .values({
        projectId, number: 1, trackerId: 1, subject: 'x', description: '',
        statusId: 1, priorityId: 2, authorId: alice.id,
      })
      .returning();
    if (!issue) throw new Error('issues insert returned no row');
    await createTimeEntryImpl(db, alice, {
      projectId, activityId: 2, hours: 1, issueId: issue.id, comments: '', spentOn: '2026-05-21',
    });
    const acts = await db.query.activities.findMany();
    const tl = acts.find((a) => a.kind === 'time_logged');
    expect(tl?.title).toContain(`on #${issue.id}`);
  });

  it('listTimeEntriesImpl filters by from/to/userId and sums hours', async () => {
    await createTimeEntryImpl(db, alice, {
      projectId, activityId: 2, hours: 1, comments: '', spentOn: '2026-05-19',
    });
    await createTimeEntryImpl(db, alice, {
      projectId, activityId: 2, hours: 2, comments: '', spentOn: '2026-05-20',
    });
    await createTimeEntryImpl(db, alice, {
      projectId, activityId: 2, hours: 4, comments: '', spentOn: '2026-05-21',
    });

    const all = await listTimeEntriesImpl(db, { projectId });
    expect(all.total).toBe(7);
    expect(all.entries).toHaveLength(3);

    const window = await listTimeEntriesImpl(db, {
      projectId,
      from: '2026-05-20',
      to: '2026-05-21',
    });
    expect(window.total).toBe(6);

    const byUser = await listTimeEntriesImpl(db, { projectId, userId: alice.id });
    expect(byUser.entries).toHaveLength(3);
  });

  it('deleteTimeEntryImpl removes the entry and returns deleted=true', async () => {
    const e = await createTimeEntryImpl(db, alice, {
      projectId, activityId: 2, hours: 1, comments: '', spentOn: '2026-05-21',
    });
    const r = await deleteTimeEntryImpl(db,e.id);
    expect(r).toEqual({ ok: true, deleted: true });
    expect(await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, e.id) })).toBeUndefined();
  });

  it('deleteTimeEntryImpl returns deleted=false on unknown id', async () => {
    const r = await deleteTimeEntryImpl(db,99999);
    expect(r).toEqual({ ok: true, deleted: false });
  });
});
