import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDB,
  addManager,
  insertProject,
  insertUser,
  makeTestDb,
} from '../_setup/db';
import { activities, issues, watchers } from '@allenlabs/pm-core/db/schema';
import {
  loadHomeImpl,
  loadMyPageImpl,
} from '~/server/home';
import { createIssueImpl } from '~/server/issues';
import { type CurrentUser } from '@allenlabs/pm-core/server/auth';

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
});

function asCurrentUser(u: { id: number; login: string; email: string }): CurrentUser {
  return {
    id: u.id,
    login: u.login,
    email: u.email,
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
  };
}

describe('loadHomeImpl', () => {
  it('returns null when sub is null (no session)', async () => {
    expect(await loadHomeImpl(db, null)).toBeNull();
  });

  it('returns empty payload when sub does not match any local user', async () => {
    const data = await loadHomeImpl(db, 'unknown-sub-id');
    // SQL still runs but the "me" CTE is empty.  Anonymous viewers see
    // the public-projects branch — none exist in this test.
    expect(data).toEqual({ projects: [], activities: [] });
  });

  it('returns empty state for an authenticated user with no projects', async () => {
    await insertUser(db, { betterAuthUserId: 'sub-alice', login: 'alice', email: 'alice@x' });
    const data = await loadHomeImpl(db, 'sub-alice');
    expect(data).toEqual({ projects: [], activities: [] });
  });

  it('returns only the public + member-of projects for a non-admin', async () => {
    const alice = await insertUser(db, { betterAuthUserId: 'sub-alice', login: 'alice', email: 'a@x' });
    const pub = await insertProject(db, { identifier: 'pub', name: 'Pub', isPublic: true });
    const priv = await insertProject(db, { identifier: 'priv', name: 'Priv', isPublic: false });
    const mine = await insertProject(db, { identifier: 'mine', name: 'Mine', isPublic: false });
    await addManager(db, alice.id, mine.id);

    const data = await loadHomeImpl(db, 'sub-alice');
    expect(data).not.toBeNull();
    const idents = data!.projects.map((p) => p.identifier).sort();
    expect(idents).toEqual(['mine', 'pub']);
    // priv is intentionally absent
    expect(idents).not.toContain(priv.identifier);
  });

  it('admin sees every project regardless of membership', async () => {
    await insertUser(db, {
      betterAuthUserId: 'sub-admin',
      login: 'admin',
      email: 'admin@x',
      admin: true,
    });
    await insertProject(db, { identifier: 'a', isPublic: false });
    await insertProject(db, { identifier: 'b', isPublic: false });
    await insertProject(db, { identifier: 'c', isPublic: true });
    const data = await loadHomeImpl(db, 'sub-admin');
    const idents = (data!.projects.map((p) => p.identifier)).sort();
    expect(idents).toEqual(['a', 'b', 'c']);
  });

  it('exposes recent activities (most recent first)', async () => {
    const alice = await insertUser(db, { betterAuthUserId: 'sub-alice', login: 'alice', email: 'a@x' });
    const p = await insertProject(db, { isPublic: true });
    await db.insert(activities).values({
      projectId: p.id,
      userId: alice.id,
      kind: 'project_created',
      refId: p.id,
      title: 'first',
    });
    await db.insert(activities).values({
      projectId: p.id,
      userId: alice.id,
      kind: 'project_created',
      refId: p.id,
      title: 'second',
    });
    const data = await loadHomeImpl(db, 'sub-alice');
    expect(data!.activities.length).toBe(2);
    expect(data!.activities[0]!.title).toBe('second');
    expect(data!.activities[0]!.userLogin).toBe('alice');
  });
});

describe('loadMyPageImpl', () => {
  it('returns null when sub is null', async () => {
    expect(await loadMyPageImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not match a local user', async () => {
    expect(await loadMyPageImpl(db, 'sub-not-real')).toBeNull();
  });

  it('returns empty buckets for a freshly-created user', async () => {
    await insertUser(db, {
      betterAuthUserId: 'sub-alice',
      login: 'alice',
      email: 'a@x',
    });
    const data = await loadMyPageImpl(db, 'sub-alice');
    expect(data).not.toBeNull();
    expect(data!.me.login).toBe('alice');
    expect(data!.myAssigned).toEqual([]);
    expect(data!.myReported).toEqual([]);
    expect(data!.watched).toEqual([]);
    expect(data!.recent).toEqual([]);
  });

  it('groups assigned + reported + watched issues into the right buckets', async () => {
    const alice = await insertUser(db, {
      betterAuthUserId: 'sub-alice',
      login: 'alice',
      email: 'a@x',
    });
    const bob = await insertUser(db, {
      betterAuthUserId: 'sub-bob',
      login: 'bob',
      email: 'b@x',
    });
    const p = await insertProject(db, { isPublic: true });

    const reportedByAlice = await createIssueImpl(db, asCurrentUser(alice), {
      projectId: p.id,
      trackerId: 1,
      subject: 'reported-by-alice',
      description: '',
      doneRatio: 0,
    });
    const reportedByBob = await createIssueImpl(db, asCurrentUser(bob), {
      projectId: p.id,
      trackerId: 1,
      subject: 'reported-by-bob',
      description: '',
      doneRatio: 0,
    });
    // bob assigns one of his issues to alice
    await db
      .update(issues)
      .set({ assignedToId: alice.id })
      .where(eq(issues.id, reportedByBob.id));
    // alice watches bob's other issue
    await db.insert(watchers).values({ issueId: reportedByBob.id, userId: alice.id });

    const data = await loadMyPageImpl(db, 'sub-alice');
    expect(data).not.toBeNull();
    expect(data!.myReported.map((i) => i.subject)).toEqual(['reported-by-alice']);
    expect(data!.myAssigned.map((i) => i.subject)).toEqual(['reported-by-bob']);
    expect(data!.watched.map((i) => i.id)).toContain(reportedByBob.id);
    // myAssigned includes denormalized status/tracker/priority colors
    const assigned = data!.myAssigned[0]!;
    expect(assigned.trackerName).toBeDefined();
    expect(assigned.statusName).toBeDefined();
    expect(assigned.priorityName).toBeDefined();
    expect(assigned.statusIsClosed).toBe(false);
    // reportedByAlice is unused beyond setup but referenced via subject above
    expect(reportedByAlice.id).toBeGreaterThan(0);
  });

  it('skips users whose status is locked even if the sub matches', async () => {
    await insertUser(db, {
      betterAuthUserId: 'sub-locked',
      login: 'locked',
      email: 'l@x',
      status: 'locked',
    });
    expect(await loadMyPageImpl(db, 'sub-locked')).toBeNull();
  });
});
