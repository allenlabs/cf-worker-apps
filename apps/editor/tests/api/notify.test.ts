// Unit tests for the Phase 16 notify.ts impls: backlinks/linked references,
// notification inbox, @date reminders, comment reactions + @mentions. Driven by
// the same tiny fake `Sql` tagged-template the other handler tests use (records
// query text + params, returns canned rows by matcher).

import { describe, it, expect } from 'vitest';
import {
  extractPageIds,
  extractCommentMentions,
  reconcilePageLinksImpl,
  backlinksImpl,
  createNotificationImpl,
  notificationsListImpl,
  unreadCountImpl,
  markReadImpl,
  reminderAddImpl,
  remindersListImpl,
  reminderCancelImpl,
  dueRemindersImpl,
  markReminderFiredImpl,
  fireDueRemindersImpl,
  notifyCommentImpl,
  notifyReactionImpl,
  reactImpl,
  reactionsForCommentsImpl,
} from '@api/handlers/notify';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}

function fakeSql(responder: (text: string, params: unknown[]) => unknown[]): {
  sql: Sql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, params });
    return Promise.resolve(responder(text, params));
  }) as unknown as Sql;
  return { sql, calls };
}

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const SELF = '33333333-3333-3333-3333-333333333333';

describe('extractPageIds', () => {
  it('pulls data-page-id and /p/<uuid> refs, deduped + lower-cased', () => {
    const html = `<a data-page-id="${U1.toUpperCase()}"></a><span>x</span>` +
      `<a href="/p/${U2}">link</a><a data-page-id="${U1}">dup</a>`;
    expect(extractPageIds(html).sort()).toEqual([U1, U2].sort());
  });

  it('excludes the source page itself', () => {
    const html = `<a data-page-id="${SELF}"></a><a data-page-id="${U1}"></a>`;
    expect(extractPageIds(html, SELF)).toEqual([U1]);
  });

  it('returns empty for empty/garbage input', () => {
    expect(extractPageIds('')).toEqual([]);
    expect(extractPageIds('no uuids here')).toEqual([]);
  });
});

describe('extractCommentMentions', () => {
  it('parses @[label](email) and bare @email, deduped + lower-cased', () => {
    const body = 'hi @[Ada L](Ada@Example.com) and @bob@example.com and @[Dup](ada@example.com)';
    expect(extractCommentMentions(body).sort()).toEqual(
      ['ada@example.com', 'bob@example.com'].sort(),
    );
  });

  it('returns empty when there are no mentions', () => {
    expect(extractCommentMentions('plain text')).toEqual([]);
    expect(extractCommentMentions('')).toEqual([]);
  });
});

describe('reconcilePageLinksImpl', () => {
  it('deletes the source rows then inserts deduped, non-self targets', async () => {
    const { sql, calls } = fakeSql(() => []);
    await reconcilePageLinksImpl(sql, SELF, [U1, U1, U2, SELF]);
    expect(calls[0]!.text).toContain('DELETE FROM editor.page_links');
    expect(calls[0]!.params).toEqual([SELF]);
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO editor.page_links'));
    expect(inserts).toHaveLength(2); // U1, U2 — dup + self dropped
    expect(inserts.map((c) => c.params[1]).sort()).toEqual([U1, U2].sort());
  });

  it('deletes even when there are no targets', async () => {
    const { sql, calls } = fakeSql(() => []);
    await reconcilePageLinksImpl(sql, SELF, []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('DELETE');
  });
});

describe('backlinksImpl', () => {
  it('maps joined rows to BacklinkItem', async () => {
    const { sql, calls } = fakeSql(() => [
      { id: U1, title: 'Src', icon: '📄', updatedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    const out = await backlinksImpl(sql, U2);
    expect(calls[0]!.params).toEqual([U2]);
    expect(out).toEqual([
      { id: U1, title: 'Src', icon: '📄', updatedAt: '2026-06-01T00:00:00.000Z' },
    ]);
  });
});

describe('createNotificationImpl', () => {
  it('inserts and returns the new id', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'n1' }]);
    const id = await createNotificationImpl(sql, {
      userEmail: 'a@x.com',
      kind: 'mention',
      pageId: U1,
    });
    expect(id).toBe('n1');
    expect(calls[0]!.params).toEqual(['a@x.com', 'mention', U1, null, null, null]);
  });

  it('throws when the insert returns no row', async () => {
    const { sql } = fakeSql(() => []);
    await expect(
      createNotificationImpl(sql, { userEmail: 'a@x.com', kind: 'comment' }),
    ).rejects.toThrow(/no row/);
  });
});

describe('notificationsListImpl', () => {
  it('caps the limit and maps rows', async () => {
    const { sql, calls } = fakeSql(() => [
      {
        id: 'n1',
        kind: 'reaction',
        pageId: U1,
        pageTitle: 'P',
        commentId: 'c1',
        actor: 'Ada',
        body: '👍',
        read: false,
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    const out = await notificationsListImpl(sql, 'a@x.com', 9999);
    expect(calls[0]!.params).toEqual(['a@x.com', 200]); // capped at 200
    expect(out[0]!.kind).toBe('reaction');
    expect(out[0]!.createdAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('unreadCountImpl', () => {
  it('returns the count', async () => {
    const { sql } = fakeSql(() => [{ count: 4 }]);
    expect(await unreadCountImpl(sql, 'a@x.com')).toBe(4);
  });
  it('defaults to 0 when no row', async () => {
    const { sql } = fakeSql(() => []);
    expect(await unreadCountImpl(sql, 'a@x.com')).toBe(0);
  });
});

describe('markReadImpl', () => {
  it('marks one by id (scoped to user)', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'n1' }]);
    const n = await markReadImpl(sql, 'a@x.com', 'n1');
    expect(n).toBe(1);
    expect(calls[0]!.text).toContain('id = ?');
    expect(calls[0]!.params).toEqual(['a@x.com', 'n1']);
  });
  it('marks all unread when no id', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'n1' }, { id: 'n2' }]);
    const n = await markReadImpl(sql, 'a@x.com');
    expect(n).toBe(2);
    expect(calls[0]!.text).not.toContain('id = ?');
    expect(calls[0]!.params).toEqual(['a@x.com']);
  });
});

describe('reminders', () => {
  const RROW = {
    id: 'r1',
    pageId: U1,
    remindAt: '2026-07-01T09:00:00.000Z',
    body: 'ping',
    fired: false,
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  it('reminderAddImpl inserts and returns the row', async () => {
    const { sql, calls } = fakeSql(() => [RROW]);
    const out = await reminderAddImpl(sql, {
      pageId: U1,
      userEmail: 'a@x.com',
      remindAt: '2026-07-01T09:00:00Z',
      body: 'ping',
    });
    expect(out.remindAt).toBe('2026-07-01T09:00:00.000Z');
    expect(calls[0]!.params).toEqual([U1, 'a@x.com', '2026-07-01T09:00:00Z', 'ping']);
  });

  it('remindersListImpl maps rows for a page+user', async () => {
    const { sql, calls } = fakeSql(() => [RROW]);
    const out = await remindersListImpl(sql, U1, 'a@x.com');
    expect(out).toHaveLength(1);
    expect(calls[0]!.params).toEqual([U1, 'a@x.com']);
  });

  it('reminderCancelImpl returns true/false on delete', async () => {
    const hit = fakeSql(() => [{ id: 'r1' }]);
    expect(await reminderCancelImpl(hit.sql, 'r1', 'a@x.com')).toBe(true);
    const miss = fakeSql(() => []);
    expect(await reminderCancelImpl(miss.sql, 'r1', 'a@x.com')).toBe(false);
  });

  it('dueRemindersImpl selects fired=false due rows', async () => {
    const { sql, calls } = fakeSql(() => [
      { id: 'r1', pageId: U1, userEmail: 'a@x.com', body: 'ping' },
    ]);
    const out = await dueRemindersImpl(sql, '2026-07-02T00:00:00Z');
    expect(out).toHaveLength(1);
    expect(calls[0]!.text).toContain('fired = false');
    expect(calls[0]!.params).toEqual(['2026-07-02T00:00:00Z']);
  });

  it('markReminderFiredImpl flips fired', async () => {
    const { sql, calls } = fakeSql(() => []);
    await markReminderFiredImpl(sql, 'r1');
    expect(calls[0]!.text).toContain('SET fired = true');
    expect(calls[0]!.params).toEqual(['r1']);
  });

  it('fireDueRemindersImpl notifies + fires each due reminder', async () => {
    const due = [
      { id: 'r1', pageId: U1, userEmail: 'a@x.com', body: 'one' },
      { id: 'r2', pageId: U2, userEmail: 'b@x.com', body: 'two' },
    ];
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT id, page_id') && text.includes('fired = false')) return due;
      if (text.includes('INSERT INTO editor.notifications')) return [{ id: 'n' }];
      return [];
    });
    const fired = await fireDueRemindersImpl(sql, '2026-07-02T00:00:00Z');
    expect(fired).toBe(2);
    expect(calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'))).toHaveLength(2);
    expect(calls.filter((c) => c.text.includes('SET fired = true'))).toHaveLength(2);
  });
});

describe('notifyCommentImpl', () => {
  it('notifies mentions + owner, skipping the actor and dedup', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT owner_id')) return [{ ownerId: 'owner@x.com' }];
      if (text.includes('INSERT INTO editor.notifications')) return [{ id: 'n' }];
      return [];
    });
    await notifyCommentImpl(sql, {
      pageId: U1,
      commentId: 'c1',
      actorEmail: 'actor@x.com',
      actorName: 'Actor',
      body: 'hey @[O](owner@x.com)',
      mentions: ['owner@x.com', 'actor@x.com'], // actor skipped
      threadId: null,
    });
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'));
    // owner@x.com gets ONE notification (mention), not a second comment one (deduped);
    // actor is never notified.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[0]).toBe('owner@x.com');
    expect(inserts[0]!.params[1]).toBe('mention');
  });

  it('notifies thread participants for an inline comment', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT owner_id')) return [{ ownerId: 'actor@x.com' }]; // owner is actor → skip
      if (text.includes('SELECT DISTINCT user_id')) return [{ userId: 'p1@x.com' }, { userId: 'actor@x.com' }];
      if (text.includes('INSERT INTO editor.notifications')) return [{ id: 'n' }];
      return [];
    });
    await notifyCommentImpl(sql, {
      pageId: U1,
      commentId: 'c1',
      actorEmail: 'actor@x.com',
      actorName: 'Actor',
      body: 'reply',
      mentions: [],
      threadId: 't1',
    });
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'));
    expect(inserts).toHaveLength(1); // only p1@x.com (owner==actor skipped)
    expect(inserts[0]!.params[0]).toBe('p1@x.com');
    expect(inserts[0]!.params[1]).toBe('comment');
  });
});

describe('notifyReactionImpl', () => {
  it('notifies the comment author', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT page_id') && text.includes('editor.comments'))
        return [{ pageId: U1, userId: 'author@x.com' }];
      if (text.includes('INSERT INTO editor.notifications')) return [{ id: 'n' }];
      return [];
    });
    await notifyReactionImpl(sql, 'c1', 'reactor@x.com', 'Reactor', '👍');
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual(['author@x.com', 'reaction', U1, 'c1', 'Reactor', '👍']);
  });

  it('is a no-op when the reactor is the author', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('editor.comments')) return [{ pageId: U1, userId: 'me@x.com' }];
      return [];
    });
    await notifyReactionImpl(sql, 'c1', 'me@x.com', 'Me', '👍');
    expect(calls.filter((c) => c.text.includes('INSERT INTO editor.notifications'))).toHaveLength(0);
  });

  it('is a no-op when the comment has no author', async () => {
    const { sql, calls } = fakeSql(() => []);
    await notifyReactionImpl(sql, 'c1', 'me@x.com', 'Me', '👍');
    expect(calls.filter((c) => c.text.includes('INSERT'))).toHaveLength(0);
  });
});

describe('reactImpl', () => {
  it('adds when absent', async () => {
    const { sql, calls } = fakeSql((text) =>
      text.includes('SELECT id FROM editor.comment_reactions') ? [] : [],
    );
    expect(await reactImpl(sql, 'c1', 'a@x.com', '👍')).toEqual({ added: true });
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.comment_reactions'))).toBe(true);
  });

  it('removes when present', async () => {
    const { sql, calls } = fakeSql((text) =>
      text.includes('SELECT id FROM editor.comment_reactions') ? [{ id: 'x' }] : [],
    );
    expect(await reactImpl(sql, 'c1', 'a@x.com', '👍')).toEqual({ added: false });
    expect(calls.some((c) => c.text.includes('DELETE FROM editor.comment_reactions'))).toBe(true);
  });
});

describe('reactionsForCommentsImpl', () => {
  it('groups by (comment, emoji) and flags the viewer', async () => {
    const { sql } = fakeSql(() => [
      { commentId: 'c1', emoji: '👍', userEmail: 'a@x.com' },
      { commentId: 'c1', emoji: '👍', userEmail: 'b@x.com' },
      { commentId: 'c1', emoji: '🎉', userEmail: 'b@x.com' },
    ]);
    const out = await reactionsForCommentsImpl(sql, ['c1'], 'a@x.com');
    const thumbs = out['c1']!.find((g) => g.emoji === '👍')!;
    expect(thumbs.count).toBe(2);
    expect(thumbs.mine).toBe(true);
    const party = out['c1']!.find((g) => g.emoji === '🎉')!;
    expect(party.mine).toBe(false);
  });

  it('returns empty for no comment ids', async () => {
    const { sql, calls } = fakeSql(() => []);
    expect(await reactionsForCommentsImpl(sql, [], 'a@x.com')).toEqual({});
    expect(calls).toHaveLength(0); // short-circuits before querying
  });
});
