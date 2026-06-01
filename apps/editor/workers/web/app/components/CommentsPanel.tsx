// Right-hand page-level comments panel (Phase 4). Lists comments oldest-first,
// supports adding, resolving/unresolving, and deleting. All mutations go
// through the createServerFn wrappers in ~/server/docs and we re-fetch the
// thread after each change (v1 keeps it simple + correct, no optimism).

import { useEffect, useState } from 'react';
import {
  commentAdd as commentAddFn,
  commentDelete as commentDeleteFn,
  commentResolve as commentResolveFn,
  commentsList as commentsListFn,
  type CommentItem,
} from '~/server/docs';

interface CommentsPanelProps {
  pageId: string;
  onClose: () => void;
}

export function CommentsPanel({ pageId, onClose }: CommentsPanelProps) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
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

  async function handleAdd() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await commentAddFn({ data: { pageId, body } });
      setDraft('');
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  async function handleResolve(c: CommentItem) {
    try {
      await commentResolveFn({ data: { id: c.id, resolved: !c.resolved } });
      await refresh();
    } catch {
      /* ignore */
    }
  }

  async function handleDelete(c: CommentItem) {
    try {
      await commentDeleteFn({ data: { id: c.id } });
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

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs text-gray-400">No comments yet.</p>
        ) : (
          comments.map((c) => (
            <div
              key={c.id}
              className={`rounded border border-gray-200 p-2 text-sm ${
                c.resolved ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium text-gray-800 truncate">
                  {c.authorName || 'Someone'}
                </span>
                <span className="text-[10px] text-gray-400 shrink-0">
                  {new Date(c.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-gray-700">{c.body}</p>
              <div className="mt-1.5 flex items-center gap-3 text-xs">
                <button
                  className="text-gray-500 hover:text-gray-800"
                  onClick={() => void handleResolve(c)}
                >
                  {c.resolved ? 'Reopen' : 'Resolve'}
                </button>
                <button
                  className="text-red-600 hover:text-red-800"
                  onClick={() => void handleDelete(c)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-gray-200 p-3">
        <textarea
          className="w-full text-sm border border-gray-200 rounded p-2 outline-none focus:border-gray-400 resize-none"
          rows={3}
          placeholder="Add a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleAdd();
            }
          }}
        />
        <button
          className="mt-2 w-full btn-primary text-sm disabled:opacity-50"
          onClick={() => void handleAdd()}
          disabled={busy || !draft.trim()}
        >
          {busy ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </aside>
  );
}
