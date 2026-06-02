// Phase 16 — backlinks / linked references, notification inbox, @date
// reminders, and comment reactions + @mentions-in-comments. Pure functions
// over a postgres.js `Sql` client (same shape as collab.ts / pages.ts), so
// they're unit-testable against the fake-Sql harness with no Hono/CF coupling.

import type { Sql } from '../lib/db';

// ---------------------------------------------------------------------------
// A. Backlinks / linked references
// ---------------------------------------------------------------------------

/**
 * Extract the set of page ids referenced FROM a chunk of saved snapshot HTML.
 * Three reference shapes are recognised (matching how the editor serialises
 * them):
 *   • mention-of-page nodes  → any element carrying  data-page-id="<uuid>"
 *   • inline child-page nodes → also carry data-page-id (same attribute)
 *   • plain links to a page   → href / src containing  /p/<uuid>
 *
 * Returns a de-duplicated array of lower-cased UUIDs. `selfId` (the source
 * page) is always excluded so a page never links to itself.
 */
export function extractPageIds(html: string, selfId?: string): string[] {
  const ids = new Set<string>();
  if (typeof html === 'string' && html.length > 0) {
    const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
    // data-page-id="<uuid>" (mention-of-page + child-page nodes)
    const attrRe = new RegExp(`data-page-id\\s*=\\s*["'](${UUID})["']`, 'g');
    // /p/<uuid> links (copy-link href, manual links)
    const linkRe = new RegExp(`/p/(${UUID})`, 'g');
    for (const re of [attrRe, linkRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        ids.add(m[1]!.toLowerCase());
      }
    }
  }
  if (selfId) ids.delete(selfId.toLowerCase());
  return Array.from(ids);
}

/**
 * Reconcile editor.page_links for one source page: the link set for `sourceId`
 * is replaced wholesale with `targetIds` (delete the old rows, insert the new
 * set). Idempotent — calling twice with the same targets is a no-op net of the
 * delete/insert. Safe to call on every snapshot save / child-page create.
 */
export async function reconcilePageLinksImpl(
  sql: Sql,
  sourceId: string,
  targetIds: string[],
): Promise<void> {
  const targets = Array.from(new Set(targetIds.map((t) => t.toLowerCase()))).filter(
    (t) => t && t !== sourceId.toLowerCase(),
  );
  await sql`DELETE FROM editor.page_links WHERE source_page_id = ${sourceId}`;
  for (const target of targets) {
    await sql`
      INSERT INTO editor.page_links (source_page_id, target_page_id)
      VALUES (${sourceId}, ${target})
      ON CONFLICT (source_page_id, target_page_id) DO NOTHING
    `;
  }
}

export interface BacklinkItem {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: string;
}

/**
 * Pages that link TO `pageId` (its linked references / backlinks). Joins the
 * graph against editor.pages so the result carries title/icon/last-edited for
 * the UI; archived sources are excluded.
 */
export async function backlinksImpl(sql: Sql, pageId: string): Promise<BacklinkItem[]> {
  const rows = await sql<{ id: string; title: string; icon: string | null; updatedAt: string }[]>`
    SELECT p.id, p.title, p.icon, p.updated_at AS "updatedAt"
    FROM editor.page_links l
    JOIN editor.pages p ON p.id = l.source_page_id
    WHERE l.target_page_id = ${pageId} AND p.archived = false
    ORDER BY p.updated_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    updatedAt: String(r.updatedAt),
  }));
}

// ---------------------------------------------------------------------------
// B. Notification inbox
// ---------------------------------------------------------------------------

export type NotificationKind = 'mention' | 'comment' | 'reminder' | 'reaction';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  pageId: string | null;
  pageTitle: string | null;
  commentId: string | null;
  actor: string | null;
  body: string | null;
  read: boolean;
  createdAt: string;
}

export interface CreateNotificationInput {
  userEmail: string;
  kind: NotificationKind;
  pageId?: string | null;
  commentId?: string | null;
  actor?: string | null;
  body?: string | null;
}

/**
 * Insert one notification row. Returns the new id. Callers MUST skip notifying
 * the actor about their own action (see commentAddImpl / reactImpl) — this fn
 * doesn't second-guess the recipient.
 */
export async function createNotificationImpl(
  sql: Sql,
  input: CreateNotificationInput,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO editor.notifications (user_email, kind, page_id, comment_id, actor, body)
    VALUES (
      ${input.userEmail}, ${input.kind}, ${input.pageId ?? null},
      ${input.commentId ?? null}, ${input.actor ?? null}, ${input.body ?? null}
    )
    RETURNING id
  `;
  if (!row) throw new Error('createNotificationImpl: insert returned no row');
  return row.id;
}

/**
 * A user's notifications, unread first then newest first, with the page title
 * joined in for the inbox row. `limit` caps the page size (default 50).
 */
export async function notificationsListImpl(
  sql: Sql,
  userEmail: string,
  limit = 50,
): Promise<NotificationItem[]> {
  const cap = Math.min(Math.max(1, limit), 200);
  const rows = await sql<
    {
      id: string;
      kind: NotificationKind;
      pageId: string | null;
      pageTitle: string | null;
      commentId: string | null;
      actor: string | null;
      body: string | null;
      read: boolean;
      createdAt: string;
    }[]
  >`
    SELECT n.id, n.kind, n.page_id AS "pageId", p.title AS "pageTitle",
           n.comment_id AS "commentId", n.actor, n.body, n.read,
           n.created_at AS "createdAt"
    FROM editor.notifications n
    LEFT JOIN editor.pages p ON p.id = n.page_id
    WHERE n.user_email = ${userEmail}
    ORDER BY n.read ASC, n.created_at DESC
    LIMIT ${cap}
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    pageId: r.pageId,
    pageTitle: r.pageTitle,
    commentId: r.commentId,
    actor: r.actor,
    body: r.body,
    read: r.read,
    createdAt: String(r.createdAt),
  }));
}

/** Count a user's unread notifications. */
export async function unreadCountImpl(sql: Sql, userEmail: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM editor.notifications
    WHERE user_email = ${userEmail} AND read = false
  `;
  return Number(row?.count ?? 0);
}

/**
 * Mark notifications read for a user. With `id` given, just that one (scoped to
 * the user so you can't mark someone else's); otherwise ALL of the user's
 * unread. Returns the number of rows updated.
 */
export async function markReadImpl(
  sql: Sql,
  userEmail: string,
  id?: string,
): Promise<number> {
  const rows =
    id === undefined
      ? await sql`
          UPDATE editor.notifications SET read = true
          WHERE user_email = ${userEmail} AND read = false
          RETURNING id
        `
      : await sql`
          UPDATE editor.notifications SET read = true
          WHERE user_email = ${userEmail} AND id = ${id}
          RETURNING id
        `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// C. @date reminders
// ---------------------------------------------------------------------------

export interface ReminderItem {
  id: string;
  pageId: string;
  remindAt: string;
  body: string | null;
  fired: boolean;
  createdAt: string;
}

export interface AddReminderInput {
  pageId: string;
  userEmail: string;
  remindAt: string; // ISO datetime
  body?: string | null;
}

/** Create a reminder for the acting user on a page. Returns the created row. */
export async function reminderAddImpl(sql: Sql, input: AddReminderInput): Promise<ReminderItem> {
  const [row] = await sql<
    {
      id: string;
      pageId: string;
      remindAt: string;
      body: string | null;
      fired: boolean;
      createdAt: string;
    }[]
  >`
    INSERT INTO editor.reminders (page_id, user_email, remind_at, body)
    VALUES (${input.pageId}, ${input.userEmail}, ${input.remindAt}, ${input.body ?? null})
    RETURNING id, page_id AS "pageId", remind_at AS "remindAt", body, fired,
              created_at AS "createdAt"
  `;
  if (!row) throw new Error('reminderAddImpl: insert returned no row');
  return toReminder(row);
}

/** A user's reminders for one page, soonest first. */
export async function remindersListImpl(
  sql: Sql,
  pageId: string,
  userEmail: string,
): Promise<ReminderItem[]> {
  const rows = await sql<
    {
      id: string;
      pageId: string;
      remindAt: string;
      body: string | null;
      fired: boolean;
      createdAt: string;
    }[]
  >`
    SELECT id, page_id AS "pageId", remind_at AS "remindAt", body, fired,
           created_at AS "createdAt"
    FROM editor.reminders
    WHERE page_id = ${pageId} AND user_email = ${userEmail}
    ORDER BY remind_at ASC
  `;
  return rows.map(toReminder);
}

/** Cancel (delete) a reminder owned by the user. Returns false if not found. */
export async function reminderCancelImpl(
  sql: Sql,
  id: string,
  userEmail: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.reminders WHERE id = ${id} AND user_email = ${userEmail} RETURNING id
  `;
  return rows.length > 0;
}

/** Reminders that are due and not yet fired (the cron worker's selection). */
export async function dueRemindersImpl(
  sql: Sql,
  nowIso: string,
): Promise<{ id: string; pageId: string; userEmail: string; body: string | null }[]> {
  const rows = await sql<
    { id: string; pageId: string; userEmail: string; body: string | null }[]
  >`
    SELECT id, page_id AS "pageId", user_email AS "userEmail", body
    FROM editor.reminders
    WHERE fired = false AND remind_at <= ${nowIso}
    ORDER BY remind_at ASC
    LIMIT 500
  `;
  return rows;
}

/** Mark a reminder fired so the cron never re-emits it. */
export async function markReminderFiredImpl(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE editor.reminders SET fired = true WHERE id = ${id}`;
}

/**
 * Fire all due reminders: for each, insert a kind=reminder notification for the
 * owner and mark it fired. Returns the count fired. This is the cron worker's
 * one-shot tick (kept here so it's unit-testable; the cron's scheduled handler
 * is a thin wrapper).
 */
export async function fireDueRemindersImpl(sql: Sql, nowIso: string): Promise<number> {
  const due = await dueRemindersImpl(sql, nowIso);
  for (const r of due) {
    await createNotificationImpl(sql, {
      userEmail: r.userEmail,
      kind: 'reminder',
      pageId: r.pageId,
      body: r.body,
    });
    await markReminderFiredImpl(sql, r.id);
  }
  return due.length;
}

function toReminder(r: {
  id: string;
  pageId: string;
  remindAt: string;
  body: string | null;
  fired: boolean;
  createdAt: string;
}): ReminderItem {
  return {
    id: r.id,
    pageId: r.pageId,
    remindAt: String(r.remindAt),
    body: r.body,
    fired: r.fired,
    createdAt: String(r.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Notification fan-out for a newly added comment
// ---------------------------------------------------------------------------

export interface NotifyCommentInput {
  pageId: string;
  commentId: string;
  /** The acting user's notification identity (email/id) — never notified. */
  actorEmail: string;
  /** Display name of the actor for the notification's `actor` label. */
  actorName: string;
  /** Comment body (stored as the notification snippet). */
  body: string;
  /** Emails @-mentioned in the body (kind=mention recipients). */
  mentions: string[];
  /** Inline thread this comment belongs to (null for a page-level comment). */
  threadId: string | null;
}

/**
 * Fan out notifications for a new comment:
 *   • each @-mentioned email (other than the actor)            → kind=mention
 *   • the page owner + other thread participants (deduped,     → kind=comment
 *     minus the actor and anyone already getting a mention)
 *
 * Identity note: owner/participant rows are keyed by editor.pages.owner_id /
 * editor.comments.user_id, which equal the actor's notification identity
 * (email when forwarded, else user id) for the same person — so dedup against
 * `actorEmail` is correct under either identity scheme.
 */
export async function notifyCommentImpl(sql: Sql, input: NotifyCommentInput): Promise<void> {
  const actor = input.actorEmail.toLowerCase();
  const notified = new Set<string>([actor]);

  // 1. @-mentions
  for (const raw of input.mentions) {
    const email = raw.toLowerCase();
    if (notified.has(email)) continue;
    notified.add(email);
    await createNotificationImpl(sql, {
      userEmail: email,
      kind: 'mention',
      pageId: input.pageId,
      commentId: input.commentId,
      actor: input.actorName,
      body: input.body,
    });
  }

  // 2. page owner
  const [ownerRow] = await sql<{ ownerId: string | null }[]>`
    SELECT owner_id AS "ownerId" FROM editor.pages WHERE id = ${input.pageId} LIMIT 1
  `;
  const recipients = new Set<string>();
  if (ownerRow?.ownerId) recipients.add(ownerRow.ownerId.toLowerCase());

  // 3. other participants in the same inline thread (their distinct user_ids)
  if (input.threadId) {
    const parts = await sql<{ userId: string | null }[]>`
      SELECT DISTINCT user_id AS "userId"
      FROM editor.comments
      WHERE page_id = ${input.pageId} AND thread_id = ${input.threadId}
    `;
    for (const p of parts) if (p.userId) recipients.add(p.userId.toLowerCase());
  }

  for (const email of recipients) {
    if (notified.has(email)) continue;
    notified.add(email);
    await createNotificationImpl(sql, {
      userEmail: email,
      kind: 'comment',
      pageId: input.pageId,
      commentId: input.commentId,
      actor: input.actorName,
      body: input.body,
    });
  }
}

/**
 * Notify a comment's author that someone reacted (kind=reaction). No-op when
 * the reactor is the author. Looks up the author's user_id to address the row.
 */
export async function notifyReactionImpl(
  sql: Sql,
  commentId: string,
  actorEmail: string,
  actorName: string,
  emoji: string,
): Promise<void> {
  const [row] = await sql<{ pageId: string | null; userId: string | null }[]>`
    SELECT page_id AS "pageId", user_id AS "userId"
    FROM editor.comments WHERE id = ${commentId} LIMIT 1
  `;
  if (!row?.userId) return;
  const author = row.userId.toLowerCase();
  if (author === actorEmail.toLowerCase()) return;
  await createNotificationImpl(sql, {
    userEmail: author,
    kind: 'reaction',
    pageId: row.pageId,
    commentId,
    actor: actorName,
    body: emoji,
  });
}

// ---------------------------------------------------------------------------
// D. Comment reactions
// ---------------------------------------------------------------------------

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Emails of the reactors — drives the "who reacted" tooltip. */
  users: string[];
  /** True if the requesting user is among them. */
  mine: boolean;
}

/**
 * Toggle one (comment, user, emoji) reaction: insert if absent, delete if
 * present. Returns the new state — true == now reacted, false == removed.
 */
export async function reactImpl(
  sql: Sql,
  commentId: string,
  userEmail: string,
  emoji: string,
): Promise<{ added: boolean }> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM editor.comment_reactions
    WHERE comment_id = ${commentId} AND user_email = ${userEmail} AND emoji = ${emoji}
    LIMIT 1
  `;
  if (existing.length > 0) {
    await sql`
      DELETE FROM editor.comment_reactions
      WHERE comment_id = ${commentId} AND user_email = ${userEmail} AND emoji = ${emoji}
    `;
    return { added: false };
  }
  await sql`
    INSERT INTO editor.comment_reactions (comment_id, user_email, emoji)
    VALUES (${commentId}, ${userEmail}, ${emoji})
    ON CONFLICT (comment_id, user_email, emoji) DO NOTHING
  `;
  return { added: true };
}

/**
 * Reactions for a set of comments, grouped by (comment, emoji). Returned as a
 * map keyed by comment id so the panel can render a reaction bar per comment.
 * `viewerEmail` marks which groups the viewer is part of.
 */
export async function reactionsForCommentsImpl(
  sql: Sql,
  commentIds: string[],
  viewerEmail: string,
): Promise<Record<string, ReactionGroup[]>> {
  const out: Record<string, ReactionGroup[]> = {};
  if (commentIds.length === 0) return out;
  const rows = await sql<
    { commentId: string; emoji: string; userEmail: string }[]
  >`
    SELECT comment_id AS "commentId", emoji, user_email AS "userEmail"
    FROM editor.comment_reactions
    WHERE comment_id = ANY(${commentIds})
    ORDER BY created_at ASC
  `;
  for (const r of rows) {
    const groups = (out[r.commentId] ??= []);
    let g = groups.find((x) => x.emoji === r.emoji);
    if (!g) {
      g = { emoji: r.emoji, count: 0, users: [], mine: false };
      groups.push(g);
    }
    g.count += 1;
    g.users.push(r.userEmail);
    if (r.userEmail === viewerEmail) g.mine = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// D. @mentions in comments
// ---------------------------------------------------------------------------

/**
 * Extract @-mentioned identities from a comment body. The composer inserts
 * mentions as `@[label](email)` (markdown-link style, stable + email-safe);
 * we also accept a bare `@email@domain` form as a fallback. Returns a unique,
 * lower-cased list of emails/ids.
 */
export function extractCommentMentions(body: string): string[] {
  const found = new Set<string>();
  if (typeof body === 'string' && body.length > 0) {
    // @[Display Name](someone@example.com)
    const linkRe = /@\[[^\]]*\]\(([^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(body)) !== null) {
      found.add(m[1]!.trim().toLowerCase());
    }
    // bare @email@domain.tld
    const bareRe = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    while ((m = bareRe.exec(body)) !== null) {
      found.add(m[1]!.trim().toLowerCase());
    }
  }
  return Array.from(found);
}
