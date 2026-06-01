// Right-hand comments panel (Phase 4 page-level + Phase 8 inline threads).
//
// Two sections:
//   • "Page comments"  — comments with thread_id NULL (the original behaviour).
//   • "Inline threads" — comments grouped by thread_id, each anchored to a text
//     range in the doc, with the selected snippet + messages + reply box.
//
// Resolving a thread hits the resolve route AND calls onThreadResolved so the
// page can strip the comment mark from the editor (which syncs via Yjs).
// Deleting the last comment of a thread does the same. We re-fetch after each
// mutation (v1 keeps it simple + correct, no optimism).

import { useEffect, useMemo, useState } from 'react';
import {
  commentAdd as commentAddFn,
  commentDelete as commentDeleteFn,
  commentResolve as commentResolveFn,
  commentsList as commentsListFn,
  type CommentItem,
} from '~/server/docs';

/** A freshly-anchored thread that has no comments yet (first reply creates it). */
export interface PendingThread {
  threadId: string;
  /** The text the user selected when anchoring — shown as context. */
  context: string;
}

interface CommentsPanelProps {
  pageId: string;
  /** Thread to scroll to / focus (the open thread). */
  activeThreadId?: string | null;
  /** A just-created thread with no comments yet. */
  pendingThread?: PendingThread | null;
  onClose: () => void;
  /** Called after a thread is resolved or fully deleted → host removes the mark. */
  onThreadResolved?: (threadId: string) => void;
  /** Called when the user focuses a thread (so the host can set activeThreadId). */
  onSelectThread?: (threadId: string | null) => void;
}

interface ThreadGroup {
  threadId: string;
  comments: CommentItem[];
}

export function CommentsPanel({
  pageId,
  activeThreadId,
  pendingThread,
  onClose,
  onThreadResolved,
  onSelectThread,
}: CommentsPanelProps) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const list = await commentsListFn({ data: { pageId } });
      setComments(list);
    } catch {
      /* ignore — keep last good state */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const pageComments = useMemo(() => comments.filter((c) => c.threadId === null), [comments]);
  const threads = useMemo<ThreadGroup[]>(() => {
    const byId = new Map<string, CommentItem[]>();
    for (const c of comments) {
      if (c.threadId === null) continue;
      const arr = byId.get(c.threadId) ?? [];
      arr.push(c);
      byId.set(c.threadId, arr);
    }
    return Array.from(byId.entries()).map(([threadId, cs]) => ({ threadId, comments: cs }));
  }, [comments]);

  // Show the pending (empty) thread even though it has no rows yet.
  const showPending = pendingThread && !threads.some((t) => t.threadId === pendingThread.threadId);

  async function addPageComment(body: string) {
    await commentAddFn({ data: { pageId, body } });
    await refresh();
  }

  async function addThreadComment(threadId: string, body: string) {
    await commentAddFn({ data: { pageId, threadId, body } });
    await refresh();
  }

  async function resolveThread(threadId: string) {
    try {
      await commentResolveFn({ data: { pageId, threadId, resolved: true } });
      onThreadResolved?.(threadId);
      if (activeThreadId === threadId) onSelectThread?.(null);
      await refresh();
    } catch {
      /* ignore */
    }
  }

  async function deleteComment(c: CommentItem) {
    try {
      await commentDeleteFn({ data: { id: c.id } });
      // If this was the last comment of an inline thread, clear its mark too.
      if (c.threadId) {
        const remaining = comments.filter((x) => x.threadId === c.threadId && x.id !== c.id);
        if (remaining.length === 0) {
          onThreadResolved?.(c.threadId);
          if (activeThreadId === c.threadId) onSelectThread?.(null);
        }
      }
      await refresh();
    } catch {
      /* ignore */
    }
  }

  async function resolvePageComment(c: CommentItem) {
    try {
      await commentResolveFn({ data: { id: c.id, resolved: !c.resolved } });
      await refresh();
    } catch {
      /* ignore */
    }
  }

  return (
    <aside className="w-80 shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <span className="text-sm font-semibold text-gray-900">Comments</span>
        <button
          className="text-gray-400 hover:text-gray-700 text-sm"
          onClick={onClose}
          aria-label="Close comments"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : (
          <>
            {/* Inline threads */}
            {(threads.length > 0 || showPending) && (
              <section data-testid="inline-threads">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
                  Inline threads
                </h3>
                <div className="space-y-3">
                  {showPending && pendingThread ? (
                    <ThreadCard
                      key={pendingThread.threadId}
                      threadId={pendingThread.threadId}
                      context={pendingThread.context}
                      comments={[]}
                      active={activeThreadId === pendingThread.threadId}
                      onFocus={() => onSelectThread?.(pendingThread.threadId)}
                      onReply={(body) => addThreadComment(pendingThread.threadId, body)}
                      onResolve={() => resolveThread(pendingThread.threadId)}
                      onDelete={deleteComment}
                    />
                  ) : null}
                  {threads.map((t) => (
                    <ThreadCard
                      key={t.threadId}
                      threadId={t.threadId}
                      comments={t.comments}
                      active={activeThreadId === t.threadId}
                      onFocus={() => onSelectThread?.(t.threadId)}
                      onReply={(body) => addThreadComment(t.threadId, body)}
                      onResolve={() => resolveThread(t.threadId)}
                      onDelete={deleteComment}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Page comments */}
            <section data-testid="page-comments">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
                Page comments
              </h3>
              {pageComments.length === 0 ? (
                <p className="text-xs text-gray-400">No page comments yet.</p>
              ) : (
                <div className="space-y-3">
                  {pageComments.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded border border-gray-200 p-2 text-sm ${
                        c.resolved ? 'opacity-60' : ''
                      }`}
                    >
                      <CommentHeader comment={c} />
                      <p className="whitespace-pre-wrap break-words text-gray-700">{c.body}</p>
                      <div className="mt-1.5 flex items-center gap-3 text-xs">
                        <button
                          className="text-gray-500 hover:text-gray-800"
                          onClick={() => void resolvePageComment(c)}
                        >
                          {c.resolved ? 'Reopen' : 'Resolve'}
                        </button>
                        <button
                          className="text-red-600 hover:text-red-800"
                          onClick={() => void deleteComment(c)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <NewCommentBox placeholder="Add a page comment…" onSubmit={addPageComment} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function CommentHeader({ comment }: { comment: CommentItem }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <span className="font-medium text-gray-800 truncate">{comment.authorName || 'Someone'}</span>
      <span className="text-[10px] text-gray-400 shrink-0">
        {new Date(comment.createdAt).toLocaleString()}
      </span>
    </div>
  );
}

interface ThreadCardProps {
  threadId: string;
  context?: string;
  comments: CommentItem[];
  active: boolean;
  onFocus: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve: () => void;
  onDelete: (c: CommentItem) => void;
}

function ThreadCard({
  context,
  comments,
  active,
  onFocus,
  onReply,
  onResolve,
  onDelete,
}: ThreadCardProps) {
  // The anchored snippet: the explicit pending context, else the first comment's
  // body isn't the anchor text — so we only show context when we have it.
  return (
    <div
      className={`rounded border p-2 text-sm cursor-pointer ${
        active ? 'border-amber-400 bg-amber-50' : 'border-gray-200'
      }`}
      onClick={onFocus}
      data-testid="thread-card"
    >
      {context ? (
        <p className="text-xs italic text-gray-500 border-l-2 border-amber-300 pl-2 mb-2 break-words">
          “{context}”
        </p>
      ) : null}
      {comments.map((c) => (
        <div key={c.id} className={`mb-2 ${c.resolved ? 'opacity-60' : ''}`}>
          <CommentHeader comment={c} />
          <p className="whitespace-pre-wrap break-words text-gray-700">{c.body}</p>
          <button
            className="text-red-600 hover:text-red-800 text-xs mt-1"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(c);
            }}
          >
            Delete
          </button>
        </div>
      ))}
      <NewCommentBox
        placeholder={comments.length === 0 ? 'Comment…' : 'Reply…'}
        onSubmit={onReply}
      />
      {comments.length > 0 ? (
        <button
          className="mt-2 text-xs text-gray-500 hover:text-gray-800"
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          Resolve thread
        </button>
      ) : null}
    </div>
  );
}

function NewCommentBox({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setDraft('');
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="w-full text-sm border border-gray-200 rounded p-2 outline-none focus:border-gray-400 resize-none"
        rows={2}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button
        className="mt-1 w-full btn-primary text-sm disabled:opacity-50"
        onClick={() => void submit()}
        disabled={busy || !draft.trim()}
      >
        {busy ? 'Posting…' : 'Comment'}
      </button>
    </div>
  );
}
