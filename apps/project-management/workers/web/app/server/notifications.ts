import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { issues, notifications, projects, users, watchers } from '~/db/schema';
import { parseMentions } from '@allenlabs/pm-core/lib/mentions';
import { getCurrentUser, getDb, requireUser } from './auth-runtime.server';

export type NotificationKind = 'assigned' | 'mentioned' | 'commented' | 'updated';

export interface NotificationRow {
  id: number;
  kind: NotificationKind;
  issueId: number;
  number: number;
  projectKey: string;
  projectIdentifier: string;
  subject: string;
  actorLogin: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export async function listNotificationsImpl(
  db: DB,
  userId: number,
  limit = 50,
): Promise<NotificationRow[]> {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      issueId: notifications.issueId,
      number: issues.number,
      projectKey: projects.key,
      projectIdentifier: projects.identifier,
      subject: issues.subject,
      actorLogin: sql<string | null>`actor.login`,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .innerJoin(issues, eq(issues.id, notifications.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(sql`users AS actor`, sql`actor.id = ${notifications.actorId}`)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows as NotificationRow[];
}

export async function unreadCountImpl(db: DB, userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row!.n;
}

export async function markReadImpl(db: DB, id: number, userId: number): Promise<{ ok: true }> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  return { ok: true };
}

export async function markAllReadImpl(db: DB, userId: number): Promise<{ ok: true }> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return { ok: true };
}

export interface DispatchOpts {
  issueId: number;
  actorId: number;
  /** Assignee to notify (set on assignment changes / new-issue assignment). */
  newAssigneeId?: number | null;
  /** Comment/description text scanned for @mentions. */
  note?: string;
  /** When true, also notify the issue's watchers. */
  notifyWatchers?: boolean;
  /** A comment was added (vs a field-only change) — affects the watcher kind. */
  isComment?: boolean;
}

/**
 * Fan a single issue event out to its recipients, de-duplicated by precedence:
 * assignee (assigned) > mention (mentioned) > watcher (commented|updated). The
 * actor never notifies themselves. No-ops when nothing matches.
 */
export async function dispatchIssueNotificationsImpl(db: DB, opts: DispatchOpts): Promise<void> {
  const recipients = new Map<number, NotificationKind>();

  if (opts.newAssigneeId != null && opts.newAssigneeId !== opts.actorId) {
    recipients.set(opts.newAssigneeId, 'assigned');
  }

  const handles = parseMentions(opts.note);
  if (handles.length > 0) {
    const inList = sql.join(
      handles.map((h) => sql`${h}`),
      sql`, `,
    );
    const matched = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`(lower(${users.login}) IN (${inList}) OR lower(coalesce(${users.username}, '')) IN (${inList}))`,
      );
    for (const u of matched) {
      if (u.id !== opts.actorId && !recipients.has(u.id)) recipients.set(u.id, 'mentioned');
    }
  }

  if (opts.notifyWatchers) {
    const ws = await db
      .select({ userId: watchers.userId })
      .from(watchers)
      .where(eq(watchers.issueId, opts.issueId));
    const kind: NotificationKind = opts.isComment ? 'commented' : 'updated';
    for (const w of ws) {
      if (w.userId !== opts.actorId && !recipients.has(w.userId)) recipients.set(w.userId, kind);
    }
  }

  if (recipients.size === 0) return;
  await db.insert(notifications).values(
    [...recipients].map(([userId, kind]) => ({
      userId,
      issueId: opts.issueId,
      actorId: opts.actorId,
      kind,
    })),
  );
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

export const listNotifications = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await getCurrentUser();
  if (!me) return [];
  return listNotificationsImpl(getDb(), me.id);
});

export const markNotificationRead = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return markReadImpl(getDb(), data.id, user.id);
  });

export const markAllNotificationsRead = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser();
  return markAllReadImpl(getDb(), user.id);
});

/* v8 ignore stop */
