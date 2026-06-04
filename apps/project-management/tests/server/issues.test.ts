import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  type TestDB,
  insertProject,
  insertUser,
  makeTestDb,
} from '../_setup/db';
import { issues, journals, watchers } from '~/db/schema';
import { type CurrentUser } from '~/server/auth';
import {
  createIssueImpl,
  deleteIssueImpl,
  getIssueImpl,
  listIssuesImpl,
  updateIssueImpl,
  watchIssueImpl,
} from '~/server/issues';
import { createLabelImpl, setIssueLabelsImpl } from '~/server/labels';

let db: TestDB;
let alice: CurrentUser;
let projectId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'alice' });
  alice = {
    id: u.id,
    login: u.login,
    email: u.email,
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
  };
  const p = await insertProject(db);
  projectId = p.id;
});

async function seedIssue(overrides: Partial<{ subject: string; trackerId: number; description: string }> = {}) {
  return createIssueImpl(db, alice, {
    projectId,
    trackerId: overrides.trackerId ?? 1,
    subject: overrides.subject ?? 'A bug',
    description: overrides.description ?? 'It broke',
    doneRatio: 0,
  });
}

describe('createIssueImpl', () => {
  it('uses default status + priority when not provided', async () => {
    const i = await seedIssue();
    expect(i.statusId).toBe(1); // New (default in seed)
    expect(i.priorityId).toBe(2); // Normal (default in seed)
    expect(i.authorId).toBe(alice.id);
  });

  it('records a project activity', async () => {
    await seedIssue({ subject: 'log me' });
    const act = await db.query.activities.findFirst();
    expect(act?.kind).toBe('issue_created');
    expect(act?.title).toContain('log me');
  });

  it('honours explicit status/priority', async () => {
    const i = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      statusId: 3,
      priorityId: 4,
      doneRatio: 50,
    });
    expect(i.statusId).toBe(3);
    expect(i.priorityId).toBe(4);
    expect(i.doneRatio).toBe(50);
  });

  it('throws if default status/priority missing', async () => {
    // wipe seeded defaults
    await db.delete((await import('~/db/schema')).issueStatuses);
    await expect(seedIssue()).rejects.toThrow(/Default status/);
  });

  it('allocates a per-project sequential number (RED-1, RED-2 …)', async () => {
    const first = await seedIssue({ subject: 'one' });
    const second = await seedIssue({ subject: 'two' });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    // A second project numbers independently from 1.
    const other = await insertProject(db, { identifier: 'other', key: 'OTH' });
    const otherFirst = await createIssueImpl(db, alice, {
      projectId: other.id,
      trackerId: 1,
      subject: 'o1',
      description: '',
      doneRatio: 0,
    });
    expect(otherFirst.number).toBe(1);
  });

  it('throws when the project does not exist', async () => {
    await expect(
      createIssueImpl(db, alice, {
        projectId: 999999,
        trackerId: 1,
        subject: 'ghost',
        description: '',
        doneRatio: 0,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('listIssuesImpl', () => {
  beforeEach(async () => {
    await seedIssue({ subject: 'open one' });
    const closed = await seedIssue({ subject: 'will close' });
    await db.update(issues).set({ statusId: 5 }).where(eq(issues.id, closed.id)); // Closed (is_closed=1)
    await seedIssue({ subject: 'second open' });
  });

  it('returns only open by default', async () => {
    const list = await listIssuesImpl(db, { projectId });
    expect(list.map((i) => i.subject).sort()).toEqual(['open one', 'second open']);
  });

  it('exposes the per-project number and project key on each row', async () => {
    const list = await listIssuesImpl(db, { projectId, statusFilter: 'all', sort: 'id' });
    for (const row of list) {
      expect(row.projectKey).toBe('DEMO'); // insertProject('demo') → key DEMO
      expect(row.number).toBeGreaterThan(0);
    }
  });

  it('returns only closed when requested', async () => {
    const list = await listIssuesImpl(db, { projectId, statusFilter: 'closed' });
    expect(list.map((i) => i.subject)).toEqual(['will close']);
  });

  it('returns all when statusFilter=all', async () => {
    const list = await listIssuesImpl(db, { projectId, statusFilter: 'all' });
    expect(list).toHaveLength(3);
  });

  it('full-text matches subject and description', async () => {
    const list = await listIssuesImpl(db, { projectId, statusFilter: 'all', q: 'close' });
    expect(list.map((i) => i.subject)).toEqual(['will close']);
  });

  it('filters by label', async () => {
    const tagged = await seedIssue({ subject: 'tagged' });
    const label = await createLabelImpl(db, { projectId, name: 'urgent' });
    await setIssueLabelsImpl(db, tagged.id, [label.id]);
    const list = await listIssuesImpl(db, { projectId, statusFilter: 'all', label: label.id });
    expect(list.map((i) => i.subject)).toEqual(['tagged']);
  });

  it('respects assignee + tracker filters', async () => {
    const u = await insertUser(db, { login: 'bob', email: 'b@x.test' });
    const mine = await seedIssue({ subject: 'mine' });
    await db.update(issues).set({ assignedToId: u.id }).where(eq(issues.id, mine.id));
    const a = await listIssuesImpl(db, { projectId, statusFilter: 'all', assignee: u.id });
    expect(a.map((i) => i.subject)).toEqual(['mine']);
    const t = await listIssuesImpl(db, { projectId, statusFilter: 'all', tracker: 1 });
    expect(t.length).toBeGreaterThan(0);
  });

  it('supports priority and id sort orders', async () => {
    const byPriority = await listIssuesImpl(db, { projectId, statusFilter: 'all', sort: 'priority' });
    expect(byPriority.length).toBe(3);
    const byId = await listIssuesImpl(db, { projectId, statusFilter: 'all', sort: 'id' });
    expect(byId[0]!.id).toBeGreaterThan(byId[byId.length - 1]!.id);
  });
});

describe('getIssueImpl', () => {
  it('returns hydrated issue with journals and children', async () => {
    const parent = await seedIssue({ subject: 'parent' });
    const child = await seedIssue({ subject: 'child' });
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, child.id));
    await updateIssueImpl(db, alice, { id: parent.id, notes: 'hello', changes: {} });

    const r = await getIssueImpl(db, parent.id);
    expect(r.issue.subject).toBe('parent');
    expect(r.children.map((c) => c.subject)).toEqual(['child']);
    expect(r.journals).toHaveLength(1);
    expect(r.journals[0]!.notes).toBe('hello');
    expect(r.tracker?.name).toBe('Bug');
  });

  it('hydrates journal details for changed-field journals', async () => {
    const i = await seedIssue();
    await updateIssueImpl(db, alice, { id: i.id, notes: 'work', changes: { statusId: 2 } });
    const r = await getIssueImpl(db, i.id);
    expect(r.journals).toHaveLength(1);
    expect(r.journals[0]!.details.length).toBeGreaterThan(0);
    expect(r.journals[0]!.details[0]!.prop_key).toBe('status');
  });

  it('returns assignee / category / version / parent when all are set', async () => {
    const { issueCategories, versions } = await import('~/db/schema');
    const [cat] = await db
      .insert(issueCategories)
      .values({ projectId, name: 'Backend' })
      .returning();
    if (!cat) throw new Error('issueCategories insert returned no row');
    const [ver] = await db
      .insert(versions)
      .values({ projectId, name: 'v1.0' })
      .returning();
    if (!ver) throw new Error('versions insert returned no row');
    const parent = await seedIssue({ subject: 'parent' });
    const child = await seedIssue({ subject: 'child' });
    await db
      .update(issues)
      .set({
        assignedToId: alice.id,
        categoryId: cat.id,
        fixedVersionId: ver.id,
        parentId: parent.id,
      })
      .where(eq(issues.id, child.id));

    const r = await getIssueImpl(db, child.id);
    expect(r.assignee?.id).toBe(alice.id);
    expect(r.category?.id).toBe(cat.id);
    expect(r.version?.id).toBe(ver.id);
    expect(r.parent?.id).toBe(parent.id);
  });

  it('records a journal detail when transitioning a previously-null field', async () => {
    const i = await seedIssue();
    // before: assignedToId is null; we set it to alice
    await updateIssueImpl(db, alice, {
      id: i.id,
      notes: '',
      changes: { assignedToId: alice.id },
    });
    const r = await getIssueImpl(db, i.id);
    const detail = r.journals[0]!.details.find((d) => d.prop_key === 'assigned_to');
    expect(detail?.oldValue).toBeNull();
    expect(detail?.newValue).toBe(String(alice.id));

    // and back to null
    await updateIssueImpl(db, alice, {
      id: i.id,
      notes: '',
      changes: { assignedToId: null },
    });
    const r2 = await getIssueImpl(db, i.id);
    const last = r2.journals[r2.journals.length - 1]!.details.find(
      (d) => d.prop_key === 'assigned_to',
    );
    expect(last?.oldValue).toBe(String(alice.id));
    expect(last?.newValue).toBeNull();
  });

  it('throws when issue is missing', async () => {
    await expect(getIssueImpl(db, 99999)).rejects.toThrow(/not found/);
  });
});

describe('updateIssueImpl', () => {
  it('writes journal_details for changed fields', async () => {
    const i = await seedIssue();
    await updateIssueImpl(db, alice, {
      id: i.id,
      notes: '',
      changes: { statusId: 2, doneRatio: 25 },
    });
    const j = await db.query.journals.findFirst({ where: eq(journals.issueId, i.id) });
    expect(j).toBeDefined();
    const details = await db.query.journalDetails.findMany();
    const props = details.map((d) => d.prop_key);
    expect(props).toContain('status');
    expect(props).toContain('done_ratio');
  });

  it('skips unchanged fields and unknown keys', async () => {
    const i = await seedIssue();
    await updateIssueImpl(db, alice, {
      id: i.id,
      notes: '',
      changes: { statusId: i.statusId, bogus: 'x' },
    });
    const journalsForIssue = await db.query.journals.findMany({
      where: eq(journals.issueId, i.id),
    });
    // no real changes -> no journal
    expect(journalsForIssue).toHaveLength(0);
  });

  it('sets closedAt when transitioning to a closed status', async () => {
    const i = await seedIssue();
    const updated = await updateIssueImpl(db, alice, {
      id: i.id,
      notes: '',
      changes: { statusId: 5 }, // Closed
    });
    expect(updated.closedAt).not.toBeNull();
  });

  it('records comment_added when only notes provided', async () => {
    const i = await seedIssue();
    await updateIssueImpl(db, alice, { id: i.id, notes: 'looks good', changes: {} });
    const act = await db.query.activities.findMany();
    const comment = act.find((a) => a.kind === 'comment_added');
    expect(comment?.title).toContain('alice');
  });

  it('throws on missing issue', async () => {
    await expect(
      updateIssueImpl(db, alice, { id: 99999, notes: '', changes: { statusId: 2 } }),
    ).rejects.toThrow(/not found/);
  });
});

describe('watchIssueImpl', () => {
  it('toggles a watcher on and off', async () => {
    const i = await seedIssue();
    await watchIssueImpl(db, alice, i.id, true);
    expect(await db.query.watchers.findMany({ where: eq(watchers.issueId, i.id) })).toHaveLength(1);
    await watchIssueImpl(db, alice, i.id, false);
    expect(await db.query.watchers.findMany({ where: eq(watchers.issueId, i.id) })).toHaveLength(0);
  });

  it('is idempotent on double-watch', async () => {
    const i = await seedIssue();
    await watchIssueImpl(db, alice, i.id, true);
    await watchIssueImpl(db, alice, i.id, true);
    expect(await db.query.watchers.findMany({ where: eq(watchers.issueId, i.id) })).toHaveLength(1);
  });

  it('getIssueImpl returns the watcher list', async () => {
    const i = await seedIssue();
    await watchIssueImpl(db, alice, i.id, true);
    const r = await getIssueImpl(db, i.id);
    expect(r.watchers).toEqual([alice.id]);
  });
});

describe('deleteIssueImpl', () => {
  it('removes the issue', async () => {
    const i = await seedIssue();
    await deleteIssueImpl(db, i.id);
    expect(await db.query.issues.findFirst({ where: eq(issues.id, i.id) })).toBeUndefined();
  });
});
