// Unit tests for the Phase 8 inline-comment impls in collab.ts. These speak raw
// parameterised SQL, so we drive them with a tiny fake `Sql` tagged-template
// that records the query text + params and returns canned rows by matcher.

import { describe, it, expect } from 'vitest';
import {
  commentsListImpl,
  commentAddImpl,
  commentResolveThreadImpl,
  commentThreadsImpl,
  type CommentItem,
} from '@api/handlers/collab';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}

/** A fake tagged-template that records calls and returns rows from a responder. */
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

const ROW = {
  id: 'c1',
  threadId: null as string | null,
  authorName: 'Ada',
  body: 'hello',
  resolved: false,
  createdAt: new Date('2026-06-01T00:00:00Z'),
};

describe('commentsListImpl', () => {
  it('lists all comments for a page when no threadId is given', async () => {
    const { sql, calls } = fakeSql(() => [ROW]);
    const out = await commentsListImpl(sql, 'page-1');
    expect(out).toHaveLength(1);
    expect(out[0]!.threadId).toBeNull();
    expect(calls[0]!.text).not.toContain('thread_id = ?');
    expect(calls[0]!.params).toEqual(['page-1']);
  });

  it('filters to a single thread when threadId is given', async () => {
    const threadRow = { ...ROW, threadId: 't-9' };
    const { sql, calls } = fakeSql(() => [threadRow]);
    const out = await commentsListImpl(sql, 'page-1', 't-9');
    expect(out[0]!.threadId).toBe('t-9');
    expect(calls[0]!.text).toContain('thread_id = ?');
    expect(calls[0]!.params).toEqual(['page-1', 't-9']);
  });
});

describe('commentAddImpl', () => {
  it('inserts a page-level comment with NULL thread_id by default', async () => {
    const { sql, calls } = fakeSql(() => [{ ...ROW }]);
    const out: CommentItem = await commentAddImpl(sql, {
      pageId: 'p',
      userId: 'u',
      authorName: 'Ada',
      body: '  trimmed  ',
    });
    expect(out.threadId).toBeNull();
    // body trimmed; thread_id then mentions are the trailing params, both null.
    expect(calls[0]!.params).toEqual(['p', 'u', 'Ada', 'trimmed', null, null]);
  });

  it('inserts with the given thread_id for an inline comment', async () => {
    const { sql, calls } = fakeSql(() => [{ ...ROW, threadId: 't-1' }]);
    const out = await commentAddImpl(sql, {
      pageId: 'p',
      userId: 'u',
      authorName: 'Ada',
      body: 'x',
      threadId: 't-1',
    });
    expect(out.threadId).toBe('t-1');
    expect(calls[0]!.params[4]).toBe('t-1');
  });

  it('throws if the insert returns no row', async () => {
    const { sql } = fakeSql(() => []);
    await expect(
      commentAddImpl(sql, { pageId: 'p', userId: 'u', authorName: 'a', body: 'b' }),
    ).rejects.toThrow(/no row/);
  });
});

describe('commentResolveThreadImpl', () => {
  it('returns true when rows were updated', async () => {
    const { sql, calls } = fakeSql(() => [{ id: 'c1' }, { id: 'c2' }]);
    const ok = await commentResolveThreadImpl(sql, 'p', 't-1', true);
    expect(ok).toBe(true);
    expect(calls[0]!.params).toEqual([true, 'p', 't-1']);
  });

  it('returns false when nothing matched', async () => {
    const { sql } = fakeSql(() => []);
    expect(await commentResolveThreadImpl(sql, 'p', 't-x', true)).toBe(false);
  });
});

describe('commentThreadsImpl', () => {
  it('maps grouped open threads to summaries with numeric counts', async () => {
    const { sql, calls } = fakeSql(() => [
      { threadId: 't-1', snippet: 'first', count: 2 },
      { threadId: 't-2', snippet: 'other', count: 1 },
    ]);
    const out = await commentThreadsImpl(sql, 'page-1');
    expect(out).toEqual([
      { threadId: 't-1', snippet: 'first', count: 2 },
      { threadId: 't-2', snippet: 'other', count: 1 },
    ]);
    // Only unresolved inline threads.
    expect(calls[0]!.text).toContain('thread_id IS NOT NULL');
    expect(calls[0]!.text).toContain('resolved = false');
  });
});
