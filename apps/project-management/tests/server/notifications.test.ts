import { beforeEach, describe, expect, it } from 'vitest';
import { host } from '~/host';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { watchers } from '@allenlabs/pm-core/db/schema';
import { type CurrentUser } from '@allenlabs/pm-core/server/auth';
import { createIssueImpl, updateIssueImpl } from '@allenlabs/pm-core/server/issues';
import {
  dispatchIssueNotificationsImpl,
  listNotificationsImpl,
  markAllReadImpl,
  markReadImpl,
  unreadCountImpl,
} from '~/server/notifications';

let db: TestDB;
let alice: CurrentUser; // actor
let bob: CurrentUser;
let carol: CurrentUser;
let projectId: number;

function asUser(u: { id: number; login: string; email: string }): CurrentUser {
  return { id: u.id, login: u.login, email: u.email, firstname: '', lastname: '', isAdmin: false, avatarUrl: null };
}

beforeEach(async () => {
  db = await makeTestDb();
  alice = asUser(await insertUser(db, { login: 'alice', email: 'a@x.test' }));
  bob = asUser(await insertUser(db, { login: 'bob', email: 'b@x.test' }));
  carol = asUser(await insertUser(db, { login: 'carol', email: 'c@x.test', username: 'carol' }));
  const p = await insertProject(db);
  projectId = p.id;
});

function makeIssue(assignedToId?: number, description = '') {
  return createIssueImpl(db, alice, {
    projectId,
    trackerId: 1,
    subject: 'thing',
    description,
    doneRatio: 0,
    assignedToId: assignedToId ?? null,
  }, host);
}

describe('dispatchIssueNotificationsImpl', () => {
  it('notifies the assignee but never the actor', async () => {
    const issue = await makeIssue();
    await dispatchIssueNotificationsImpl(db, { issueId: issue.id, actorId: alice.id, newAssigneeId: bob.id });
    await dispatchIssueNotificationsImpl(db, { issueId: issue.id, actorId: alice.id, newAssigneeId: alice.id });
    const forBob = await listNotificationsImpl(db, bob.id);
    expect(forBob.map((n) => n.kind)).toEqual(['assigned']);
    expect(await listNotificationsImpl(db, alice.id)).toEqual([]); // actor not self-notified
  });

  it('notifies @mentioned users resolved by login or username', async () => {
    const issue = await makeIssue();
    await dispatchIssueNotificationsImpl(db, {
      issueId: issue.id,
      actorId: alice.id,
      note: 'cc @bob and @CAROL please',
    });
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['mentioned']);
    expect((await listNotificationsImpl(db, carol.id)).map((n) => n.kind)).toEqual(['mentioned']);
  });

  it('notifies watchers with commented/updated kind, skipping higher-precedence recipients', async () => {
    const issue = await makeIssue();
    await db.insert(watchers).values([
      { issueId: issue.id, userId: bob.id },
      { issueId: issue.id, userId: carol.id },
    ]);
    // bob is also the new assignee → he keeps 'assigned', carol gets 'commented'.
    await dispatchIssueNotificationsImpl(db, {
      issueId: issue.id,
      actorId: alice.id,
      newAssigneeId: bob.id,
      notifyWatchers: true,
      isComment: true,
    });
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['assigned']);
    expect((await listNotificationsImpl(db, carol.id)).map((n) => n.kind)).toEqual(['commented']);
  });

  it('uses updated kind for field-only watcher notifications', async () => {
    const issue = await makeIssue();
    await db.insert(watchers).values({ issueId: issue.id, userId: bob.id });
    await dispatchIssueNotificationsImpl(db, {
      issueId: issue.id,
      actorId: alice.id,
      notifyWatchers: true,
      isComment: false,
    });
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['updated']);
  });

  it('skips mentions of the actor and of users already queued', async () => {
    const issue = await makeIssue();
    // @alice is the actor (skipped); @bob is already the assignee (kept as
    // 'assigned', not downgraded to 'mentioned').
    await dispatchIssueNotificationsImpl(db, {
      issueId: issue.id,
      actorId: alice.id,
      newAssigneeId: bob.id,
      note: 'cc @alice @bob',
    });
    expect(await unreadCountImpl(db, alice.id)).toBe(0);
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['assigned']);
  });

  it('no-ops when there are no recipients', async () => {
    const issue = await makeIssue();
    await dispatchIssueNotificationsImpl(db, { issueId: issue.id, actorId: alice.id, note: 'no mentions here' });
    expect(await unreadCountImpl(db, bob.id)).toBe(0);
  });
});

describe('read state', () => {
  it('tracks unread count and marks one / all read', async () => {
    const issue = await makeIssue();
    await dispatchIssueNotificationsImpl(db, { issueId: issue.id, actorId: alice.id, newAssigneeId: bob.id, note: '@carol' });
    await dispatchIssueNotificationsImpl(db, { issueId: issue.id, actorId: alice.id, note: '@bob again' });

    expect(await unreadCountImpl(db, bob.id)).toBe(2);
    const list = await listNotificationsImpl(db, bob.id);
    await markReadImpl(db, list[0]!.id, bob.id);
    expect(await unreadCountImpl(db, bob.id)).toBe(1);
    await markAllReadImpl(db, bob.id);
    expect(await unreadCountImpl(db, bob.id)).toBe(0);
  });

  it('lists with issue key, subject, and actor', async () => {
    const issue = await makeIssue(bob.id);
    const [n] = await listNotificationsImpl(db, bob.id);
    expect(n!.kind).toBe('assigned');
    expect(n!.number).toBe(issue.number);
    expect(n!.projectKey).toBe('DEMO');
    expect(n!.subject).toBe('thing');
    expect(n!.actorLogin).toBe('alice');
  });
});

describe('issue events generate notifications', () => {
  it('createIssue notifies the assignee', async () => {
    await makeIssue(bob.id);
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['assigned']);
  });

  it('updateIssue notifies a newly assigned user and watchers', async () => {
    const issue = await makeIssue();
    await db.insert(watchers).values({ issueId: issue.id, userId: carol.id });
    await updateIssueImpl(db, alice, {
      id: issue.id,
      notes: 'taking a look',
      changes: { assignedToId: bob.id },
    }, host);
    expect((await listNotificationsImpl(db, bob.id)).map((n) => n.kind)).toEqual(['assigned']);
    expect((await listNotificationsImpl(db, carol.id)).map((n) => n.kind)).toEqual(['commented']);
  });

  it('unassigning notifies nobody about assignment', async () => {
    const issue = await makeIssue(bob.id); // bob gets the initial 'assigned'
    await markAllReadImpl(db, bob.id);
    await updateIssueImpl(db, alice, { id: issue.id, notes: '', changes: { assignedToId: null } }, host);
    // No new 'assigned' notification from the unassign (null assignee).
    expect(await unreadCountImpl(db, bob.id)).toBe(0);
  });
});
