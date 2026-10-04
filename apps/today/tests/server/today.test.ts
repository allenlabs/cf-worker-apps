import { describe, expect, it } from 'vitest';
import {
  insertFocusSession,
  insertInboxItem,
  insertPmActivity,
  insertPmIssue,
  insertPmProject,
  insertPmStatus,
  insertPmUser,
  makeTestDb,
} from '../_setup/db';
import {
  loadTodayImpl,
  pickOneNextAction,
  type PmAssignedRow,
  type InboxUnreadRow,
} from '~/server/today';

// ---------- pickOneNextAction ----------

describe('pickOneNextAction', () => {
  const baseInbox: InboxUnreadRow[] = [];
  const basePm: PmAssignedRow[] = [];

  it('returns null when nothing is actionable', () => {
    expect(
      pickOneNextAction({ activeFocus: null, pmAssigned: basePm, inboxUnread: baseInbox }),
    ).toBeNull();
  });

  it('prefers the active focus session above everything', () => {
    const action = pickOneNextAction({
      activeFocus: {
        id: 1,
        taskText: 'fix auth bug',
        targetMinutes: 25,
        startedAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      },
      pmAssigned: [
        {
          id: 42,
          subject: 'overdue thing',
          projectIdentifier: 'core',
          projectName: 'Core',
          dueDate: '2020-01-01',
          updatedAt: new Date().toISOString(),
          statusIsClosed: false,
          statusName: 'Open',
        },
      ],
      inboxUnread: [
        { id: 1, text: 'top capture', capturedAt: new Date().toISOString(), source: 'web' },
      ],
    });
    expect(action?.kind).toBe('focus');
    expect(action?.label).toBe('fix auth bug');
    expect(action?.url).toBe('https://focus.allenlabs.org/');
  });

  it('picks an overdue PM issue next', () => {
    const now = new Date('2026-05-24T10:00:00');
    const action = pickOneNextAction(
      {
        activeFocus: null,
        pmAssigned: [
          {
            id: 7,
            subject: 'fix login crash',
            projectIdentifier: 'web',
            projectName: 'Web',
            dueDate: '2026-05-20',
            updatedAt: now.toISOString(),
            statusIsClosed: false,
            statusName: 'Open',
          },
        ],
        inboxUnread: [
          { id: 1, text: 'inbox capture', capturedAt: now.toISOString(), source: null },
        ],
      },
      now,
    );
    expect(action?.kind).toBe('overdue');
    expect(action?.label).toBe('fix login crash');
    expect(action?.url).toBe('https://projects.allenlabs.org/projects/web/issues/7');
  });

  it('picks a due-today PM issue when nothing is overdue', () => {
    const now = new Date('2026-05-24T10:00:00');
    const action = pickOneNextAction(
      {
        activeFocus: null,
        pmAssigned: [
          {
            id: 9,
            subject: 'PR review',
            projectIdentifier: 'core',
            projectName: 'Core',
            dueDate: '2026-05-24',
            updatedAt: now.toISOString(),
            statusIsClosed: false,
            statusName: 'Open',
          },
        ],
        inboxUnread: [],
      },
      now,
    );
    expect(action?.kind).toBe('due-today');
    expect(action?.url).toBe('https://projects.allenlabs.org/projects/core/issues/9');
  });

  it('falls back to the top of the inbox unread queue', () => {
    const action = pickOneNextAction({
      activeFocus: null,
      pmAssigned: [],
      inboxUnread: [
        {
          id: 11,
          text: 'remember to drink water',
          capturedAt: new Date().toISOString(),
          source: 'cli',
        },
      ],
    });
    expect(action?.kind).toBe('inbox');
    expect(action?.label).toBe('remember to drink water');
    expect(action?.url).toBe('https://inbox.allenlabs.org/');
  });

  it('truncates very long inbox captures in the hero label', () => {
    const longText = 'a'.repeat(400);
    const action = pickOneNextAction({
      activeFocus: null,
      pmAssigned: [],
      inboxUnread: [
        { id: 1, text: longText, capturedAt: new Date().toISOString(), source: null },
      ],
    });
    expect(action?.label.length).toBe(201); // 200 + ellipsis
    expect(action?.label.endsWith('…')).toBe(true);
  });

  it('ignores PM issues with no due_date when picking overdue / due-today', () => {
    const action = pickOneNextAction({
      activeFocus: null,
      pmAssigned: [
        {
          id: 1,
          subject: 'no due',
          projectIdentifier: 'a',
          projectName: 'A',
          dueDate: null,
          updatedAt: new Date().toISOString(),
          statusIsClosed: false,
          statusName: 'Open',
        },
      ],
      inboxUnread: [
        { id: 1, text: 'fallback', capturedAt: new Date().toISOString(), source: null },
      ],
    });
    expect(action?.kind).toBe('inbox');
  });
});

// ---------- loadTodayImpl ----------

describe('loadTodayImpl', () => {
  it('returns null when sub is missing', async () => {
    const db = await makeTestDb();
    expect(await loadTodayImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map to a pm.users row', async () => {
    const db = await makeTestDb();
    expect(await loadTodayImpl(db, 'unknown-sso')).toBeNull();
  });

  it('reports the full dashboard payload in one call', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const project = await insertPmProject(db, 'core', 'Core');
    const open = await insertPmStatus(db, 'Open', false);
    const closed = await insertPmStatus(db, 'Closed', true);

    // Three assigned issues — one overdue, one due today, one no-due-date —
    // plus a closed one that must be filtered out.
    const now = new Date('2026-05-24T10:00:00Z');
    const overdueId = await insertPmIssue(db, {
      projectId: project.id,
      subject: 'overdue thing',
      statusId: open.id,
      authorId: u.id,
      assignedToId: u.id,
      dueDate: '2026-05-20',
      updatedAt: new Date('2026-05-20T10:00:00Z'),
    });
    const dueTodayId = await insertPmIssue(db, {
      projectId: project.id,
      subject: 'due today',
      statusId: open.id,
      authorId: u.id,
      assignedToId: u.id,
      dueDate: '2026-05-24',
    });
    await insertPmIssue(db, {
      projectId: project.id,
      subject: 'no due date',
      statusId: open.id,
      authorId: u.id,
      assignedToId: u.id,
    });
    await insertPmIssue(db, {
      projectId: project.id,
      subject: 'closed should not show',
      statusId: closed.id,
      authorId: u.id,
      assignedToId: u.id,
    });
    // Inbox: two unread, one done.
    await insertInboxItem(db, { userId: u.id, text: 'refill meds' });
    await insertInboxItem(db, { userId: u.id, text: 'review PR #42' });
    await insertInboxItem(db, { userId: u.id, text: 'done item', status: 'done' });
    // Focus: one completed session at start-of-day + one active.
    const dayStart = new Date(Date.UTC(2026, 4, 24, 6, 0, 0));
    await insertFocusSession(db, {
      userId: u.id,
      taskText: 'morning warm-up',
      targetMinutes: 25,
      startedAt: dayStart,
      endedAt: new Date(dayStart.getTime() + 25 * 60_000),
      endedReason: 'completed',
    });
    await insertFocusSession(db, {
      userId: u.id,
      taskText: 'now focusing',
      targetMinutes: 45,
      startedAt: new Date(dayStart.getTime() + 90 * 60_000),
    });
    // Activity: two rows for me, one for someone else.
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    await insertPmActivity(db, {
      userId: u.id,
      title: 'commented on #1',
      kind: 'commented',
      projectId: project.id,
    });
    await insertPmActivity(db, {
      userId: u.id,
      title: 'closed #2',
      kind: 'closed',
      projectId: project.id,
    });
    await insertPmActivity(db, {
      userId: bob.id,
      title: 'bob did a thing',
      kind: 'commented',
    });

    const payload = await loadTodayImpl(db, 'sso-alice', now);
    expect(payload).not.toBeNull();
    expect(payload!.me.login).toBe('alice');
    // Active focus session is set + endsAt derived.
    expect(payload!.activeFocus).not.toBeNull();
    expect(payload!.activeFocus!.taskText).toBe('now focusing');
    expect(payload!.activeFocus!.targetMinutes).toBe(45);
    // PM assigned: 3 open, sorted by due (overdue first, then due-today,
    // then null).
    expect(payload!.pmAssigned).toHaveLength(3);
    expect(payload!.pmAssigned[0]!.id).toBe(overdueId);
    expect(payload!.pmAssigned[1]!.id).toBe(dueTodayId);
    expect(payload!.pmAssigned[2]!.dueDate).toBeNull();
    // No closed issue snuck in.
    expect(payload!.pmAssigned.find((i) => i.subject.includes('closed'))).toBeUndefined();
    // Inbox: 2 unread, count 2, no done item.
    expect(payload!.inboxCount.unread).toBe(2);
    expect(payload!.inboxUnread).toHaveLength(2);
    expect(payload!.inboxUnread.map((i) => i.text).sort()).toEqual([
      'refill meds',
      'review PR #42',
    ]);
    // Focus today: 25 completed minutes, 2 sessions.
    expect(payload!.focusToday.totalMinutes).toBe(25);
    expect(payload!.focusToday.sessionCount).toBe(2);
    // Heatmap: 7 entries; today's bucket should reflect the 25 completed.
    expect(payload!.focusHeatmap.days).toHaveLength(7);
    expect(payload!.focusHeatmap.days[6]).toBe(25);
    // Activity: my 2 only.
    expect(payload!.recentActivity).toHaveLength(2);
    expect(payload!.recentActivity.every((a) => !a.title.includes('bob'))).toBe(true);
  });

  it('soft-fails when inbox.items does not exist on this DB', async () => {
    const db = await makeTestDb({ withInbox: false });
    await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const payload = await loadTodayImpl(db, 'sso-alice');
    expect(payload).not.toBeNull();
    expect(payload!.inboxUnread).toEqual([]);
    expect(payload!.inboxCount.unread).toBe(0);
  });

  it('soft-fails when focus.sessions does not exist on this DB', async () => {
    const db = await makeTestDb({ withFocus: false });
    await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const payload = await loadTodayImpl(db, 'sso-alice');
    expect(payload).not.toBeNull();
    expect(payload!.activeFocus).toBeNull();
    expect(payload!.focusToday.totalMinutes).toBe(0);
    expect(payload!.focusToday.sessionCount).toBe(0);
    expect(payload!.focusHeatmap.days).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('does not leak another user\'s data', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const project = await insertPmProject(db, 'core', 'Core');
    const open = await insertPmStatus(db, 'Open', false);
    await insertPmIssue(db, {
      projectId: project.id,
      subject: 'alice issue',
      statusId: open.id,
      authorId: alice.id,
      assignedToId: alice.id,
    });
    await insertInboxItem(db, { userId: alice.id, text: 'alice secret' });
    await insertFocusSession(db, {
      userId: alice.id,
      taskText: 'alice working',
    });
    await insertPmActivity(db, { userId: alice.id, title: 'alice did X' });

    const payload = await loadTodayImpl(db, 'sso-bob');
    expect(payload).not.toBeNull();
    expect(payload!.pmAssigned).toEqual([]);
    expect(payload!.inboxUnread).toEqual([]);
    expect(payload!.activeFocus).toBeNull();
    expect(payload!.recentActivity).toEqual([]);
    // The unused bob var is referenced to keep TS happy if the test grows.
    expect(bob.id).toBeGreaterThan(0);
  });
});
