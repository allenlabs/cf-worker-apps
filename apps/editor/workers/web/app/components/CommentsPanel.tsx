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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  commentAdd as commentAddFn,
  commentDelete as commentDeleteFn,
  commentReact as commentReactFn,
  commentReactions as commentReactionsFn,
  commentResolve as commentResolveFn,
  commentsList as commentsListFn,
  searchMentions as searchMentionsFn,
  type CommentItem,
  type MentionResult,
  type ReactionGroup,
} from '~/server/docs';
import { EmojiPicker } from '~/components/EmojiPicker';
import { Skeleton } from '~/components/Skeleton';

/** Render a comment body, turning @[label](id) mention tokens into chips. */
function renderBody(body: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /@\[([^\]]*)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(
      <span
        key={`m-${key++}`}
        className="inline-flex items-center rounded bg-blue-50 px-1 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"
      >
        @{m[1] || m[2]}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length > 0 ? parts : body;
}

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
  const { t } = useT();
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [reactions, setReactions] = useState<Record<string, ReactionGroup[]>>({});
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const list = await commentsListFn({ data: { pageId } });
      setComments(list);
      const ids = list.map((c) => c.id);
      if (ids.length > 0) {
        try {
          setReactions(await commentReactionsFn({ data: { commentIds: ids } }));
        } catch {
          /* reactions are non-critical */
        }
      } else {
        setReactions({});
      }
    } catch {
      /* ignore — keep last good state */
    } finally {
      setLoading(false);
    }
  }

  async function toggleReaction(commentId: string, emoji: string) {
    try {
      await commentReactFn({ data: { commentId, emoji } });
      await refresh();
    } catch {
      /* ignore */
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
    <aside className="w-80 shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('comments.title')}</span>
        <button
          className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 text-sm"
          onClick={onClose}
          aria-label={t('comments.close')}
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading ? (
          <div className="space-y-3" aria-label={t('comments.loading')} aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            {/* Inline threads */}
            {(threads.length > 0 || showPending) && (
              <section data-testid="inline-threads">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
                  {t('comments.inlineThreads')}
                </h3>
                <div className="space-y-3">
                  {showPending && pendingThread ? (
                    <ThreadCard
                      key={pendingThread.threadId}
                      threadId={pendingThread.threadId}
                      context={pendingThread.context}
                      comments={[]}
                      reactions={reactions}
                      active={activeThreadId === pendingThread.threadId}
                      onFocus={() => onSelectThread?.(pendingThread.threadId)}
                      onReply={(body) => addThreadComment(pendingThread.threadId, body)}
                      onResolve={() => resolveThread(pendingThread.threadId)}
                      onDelete={deleteComment}
                      onReact={toggleReaction}
                    />
                  ) : null}
                  {threads.map((t) => (
                    <ThreadCard
                      key={t.threadId}
                      threadId={t.threadId}
                      comments={t.comments}
                      reactions={reactions}
                      active={activeThreadId === t.threadId}
                      onFocus={() => onSelectThread?.(t.threadId)}
                      onReply={(body) => addThreadComment(t.threadId, body)}
                      onResolve={() => resolveThread(t.threadId)}
                      onDelete={deleteComment}
                      onReact={toggleReaction}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Page comments */}
            <section data-testid="page-comments">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
                {t('comments.pageComments')}
              </h3>
              {pageComments.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('comments.noPageComments')}</p>
              ) : (
                <div className="space-y-3">
                  {pageComments.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded border border-gray-200 dark:border-gray-700 p-2 text-sm ${
                        c.resolved ? 'opacity-60' : ''
                      }`}
                    >
                      <CommentHeader comment={c} />
                      <p className="whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
                        {renderBody(c.body)}
                      </p>
                      <ReactionBar
                        groups={reactions[c.id] ?? []}
                        onToggle={(emoji) => void toggleReaction(c.id, emoji)}
                      />
                      <div className="mt-1.5 flex items-center gap-3 text-xs">
                        <button
                          className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
                          onClick={() => void resolvePageComment(c)}
                        >
                          {c.resolved ? t('comments.reopen') : t('comments.resolve')}
                        </button>
                        <button
                          className="text-red-600 hover:text-red-800"
                          onClick={() => void deleteComment(c)}
                        >
                          {t('comments.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <NewCommentBox placeholder={t('comments.addPlaceholder')} onSubmit={addPageComment} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function CommentHeader({ comment }: { comment: CommentItem }) {
  const { t } = useT();
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <span className="font-medium text-gray-800 dark:text-gray-200 truncate">
        {comment.authorName || t('comments.someone')}
      </span>
      <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
        {new Date(comment.createdAt).toLocaleString()}
      </span>
    </div>
  );
}

interface ThreadCardProps {
  threadId: string;
  context?: string;
  comments: CommentItem[];
  reactions: Record<string, ReactionGroup[]>;
  active: boolean;
  onFocus: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve: () => void;
  onDelete: (c: CommentItem) => void;
  onReact: (commentId: string, emoji: string) => void;
}

function ThreadCard({
  context,
  comments,
  reactions,
  active,
  onFocus,
  onReply,
  onResolve,
  onDelete,
  onReact,
}: ThreadCardProps) {
  const { t } = useT();
  // The anchored snippet: the explicit pending context, else the first comment's
  // body isn't the anchor text — so we only show context when we have it.
  return (
    <div
      className={`rounded border p-2 text-sm cursor-pointer ${
        active ? 'border-amber-400 bg-amber-50' : 'border-gray-200 dark:border-gray-700'
      }`}
      onClick={onFocus}
      data-testid="thread-card"
    >
      {context ? (
        <p className="text-xs italic text-gray-500 dark:text-gray-400 border-l-2 border-amber-300 pl-2 mb-2 break-words">
          “{context}”
        </p>
      ) : null}
      {comments.map((c) => (
        <div key={c.id} className={`mb-2 ${c.resolved ? 'opacity-60' : ''}`}>
          <CommentHeader comment={c} />
          <p className="whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{renderBody(c.body)}</p>
          <div onClick={(e) => e.stopPropagation()}>
            <ReactionBar
              groups={reactions[c.id] ?? []}
              onToggle={(emoji) => onReact(c.id, emoji)}
            />
          </div>
          <button
            className="text-red-600 hover:text-red-800 text-xs mt-1"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(c);
            }}
          >
            {t('comments.delete')}
          </button>
        </div>
      ))}
      <NewCommentBox
        placeholder={
          comments.length === 0 ? t('comments.commentPlaceholder') : t('comments.replyPlaceholder')
        }
        onSubmit={onReply}
      />
      {comments.length > 0 ? (
        <button
          className="mt-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
        >
          {t('comments.resolveThread')}
        </button>
      ) : null}
    </div>
  );
}

/** A reaction bar: existing emoji groups (toggle on click) + an add button. */
function ReactionBar({
  groups,
  onToggle,
}: {
  groups: ReactionGroup[];
  onToggle: (emoji: string) => void;
}) {
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  if (groups.length === 0 && !picking) {
    return (
      <div className="mt-1.5">
        <button
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
          onClick={(e) => {
            e.stopPropagation();
            setPicking(true);
          }}
          aria-label={t('reactions.add')}
          data-testid="react-add"
        >
          ＋😊
        </button>
        {picking ? (
          <ReactionPicker
            onPick={(emoji) => {
              onToggle(emoji);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        ) : null}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 relative" data-testid="reaction-bar">
      {groups.map((g) => (
        <button
          key={g.emoji}
          className={`px-1.5 py-0.5 rounded-full border text-xs ${
            g.mine
              ? 'border-blue-300 bg-blue-50 dark:bg-blue-900/40'
              : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(g.emoji);
          }}
          title={g.users.join(', ')}
        >
          {g.emoji} {g.count}
        </button>
      ))}
      <button
        className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 px-1"
        onClick={(e) => {
          e.stopPropagation();
          setPicking((v) => !v);
        }}
        aria-label={t('reactions.add')}
        data-testid="react-add"
      >
        ＋
      </button>
      {picking ? (
        <ReactionPicker
          onPick={(emoji) => {
            onToggle(emoji);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function ReactionPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute z-30 top-6 left-0" onClick={(e) => e.stopPropagation()}>
      <EmojiPicker onPick={onPick} onClose={onClose} />
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
  const { t } = useT();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // @-mention autocomplete state.
  const [suggestions, setSuggestions] = useState<MentionResult[]>([]);
  const [queryStart, setQueryStart] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setDraft('');
      setSuggestions([]);
      setQueryStart(null);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  // Detect an in-progress "@query" at the caret and fetch matching members.
  function onChange(value: string, caret: number) {
    setDraft(value);
    const upto = value.slice(0, caret);
    const m = /@([\w.\-]*)$/.exec(upto);
    if (m) {
      const q = m[1] ?? '';
      const start = caret - q.length - 1; // index of the '@'
      setQueryStart(start);
      void searchMentionsFn({ data: { q } })
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    } else {
      setQueryStart(null);
      setSuggestions([]);
    }
  }

  // Replace the in-progress @query with a @[label](id) token.
  function pickMention(mres: MentionResult) {
    if (queryStart === null) return;
    const caret = taRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, queryStart);
    const after = draft.slice(caret);
    const token = `@[${mres.label}](${mres.id}) `;
    const next = `${before}${token}${after}`;
    setDraft(next);
    setSuggestions([]);
    setQueryStart(null);
  }

  return (
    <div className="mt-2 relative" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={taRef}
        className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded p-2 outline-none focus:border-gray-400 resize-none"
        rows={2}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        aria-label={t('comments.mentionPlaceholder')}
      />
      {suggestions.length > 0 ? (
        <ul
          className="absolute z-30 left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg dark:bg-gray-800 dark:border-gray-700"
          data-testid="mention-suggestions"
        >
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                className="block w-full text-left px-2 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
                onClick={() => pickMention(s)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        className="mt-1 w-full btn-primary text-sm disabled:opacity-50"
        onClick={() => void submit()}
        disabled={busy || !draft.trim()}
      >
        {busy ? t('comments.posting') : t('comments.comment')}
      </button>
    </div>
  );
}
