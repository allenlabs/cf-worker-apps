// Loader impls for the two highest-traffic routes — `/` and `/my/page`.
//
// Both are driven by a single CTE that resolves the current user and the
// page's data in ONE Hetzner round-trip.  We extract the SQL out of the
// route file so the logic can be unit-tested against a PGlite DB without
// the TanStack Start runtime.

import { sql } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { extractRows } from '@allenlabs/pm-core/server/projects';

export interface HomePayload {
  projects: Array<{
    id: number;
    identifier: string;
    name: string;
    description: string;
    isPublic: boolean;
    status: string;
  }>;
  activities: Array<{
    id: number;
    title: string;
    createdAt: string;
    userLogin: string;
    projectName: string | null;
  }>;
}

export async function loadHomeImpl(db: DB, sub: string | null): Promise<HomePayload | null> {
  if (!sub) return null;
  const result = (await db.execute(
    sql`
  WITH
  me AS (
    SELECT id, admin AS "isAdmin" FROM pm.users
    WHERE better_auth_user_id = ${sub} AND status = 'active' LIMIT 1
  ),
  user_projects AS (
    SELECT p.id, p.identifier, p.name, p.description, p.is_public AS "isPublic", p.status
    FROM pm.projects p
    WHERE p.status = 'active'
      AND (
        p.is_public
        OR (SELECT "isAdmin" FROM me)
        OR EXISTS (
          SELECT 1 FROM pm.members m
          INNER JOIN pm.roles r ON r.id = m.role_id
          WHERE m.user_id = (SELECT id FROM me) AND m.project_id = p.id
        )
      )
    ORDER BY p.name
  ),
  recent AS (
    SELECT a.id, a.title, a.created_at AS "createdAt",
           u.login AS "userLogin",
           p.name AS "projectName"
    FROM pm.activities a
    JOIN pm.users u ON u.id = a.user_id
    LEFT JOIN pm.projects p ON p.id = a.project_id
    ORDER BY a.created_at DESC LIMIT 20
  )
  SELECT json_build_object(
    'projects',  COALESCE((SELECT json_agg(up) FROM user_projects up), '[]'::json),
    'activities', COALESCE((SELECT json_agg(r) FROM recent r), '[]'::json)
  ) AS data
    `,
  )) as unknown;
  // SELECT json_build_object always returns exactly one row, and the
  // CTE COALESCEs each projection to an array — so we can trust the
  // shape without a defensive fallback.
  const [first] = extractRows(result);
  return (first as { data: HomePayload }).data;
}

export interface MyPagePayload {
  me: {
    id: number;
    login: string;
    email: string;
    firstname: string;
    lastname: string;
    isAdmin: boolean;
    avatarUrl: string | null;
  };
  myAssigned: Array<{
    id: number;
    number: number;
    projectKey: string;
    subject: string;
    projectId: number;
    projectIdentifier: string;
    projectName: string;
    trackerName: string;
    trackerColor: string;
    statusName: string;
    statusColor: string;
    statusIsClosed: boolean;
    priorityName: string;
    priorityColor: string;
    dueDate: string | null;
    updatedAt: string;
  }>;
  myReported: Array<{
    id: number;
    number: number;
    projectKey: string;
    subject: string;
    projectIdentifier: string;
    statusName: string;
    statusColor: string;
    updatedAt: string;
  }>;
  watched: Array<{
    id: number;
    number: number;
    projectKey: string;
    subject: string;
    projectIdentifier: string;
    statusName: string;
    statusColor: string;
    updatedAt: string;
  }>;
  recent: Array<{
    id: number;
    kind: string;
    title: string;
    body: string;
    createdAt: string;
    refId: number;
    projectId: number | null;
    projectName: string | null;
    userId: number;
    userLogin: string;
  }>;
}

export async function loadMyPageImpl(db: DB, sub: string | null): Promise<MyPagePayload | null> {
  if (!sub) return null;
  const result = (await db.execute(
    sql`
  WITH
  me AS (
    SELECT id, login, email, firstname, lastname, admin AS "isAdmin", avatar_url AS "avatarUrl"
    FROM pm.users
    WHERE better_auth_user_id = ${sub} AND status = 'active'
    LIMIT 1
  ),
  my_assigned AS (
    SELECT
      i.id, i.number AS "number", p.key AS "projectKey",
      i.subject, i.project_id AS "projectId",
      p.identifier AS "projectIdentifier", p.name AS "projectName",
      t.name AS "trackerName", t.color AS "trackerColor",
      s.name AS "statusName", s.color AS "statusColor", s.is_closed AS "statusIsClosed",
      pr.name AS "priorityName", pr.color AS "priorityColor",
      i.due_date AS "dueDate", i.updated_at AS "updatedAt"
    FROM pm.issues i
    JOIN pm.projects p ON p.id = i.project_id
    JOIN pm.trackers t ON t.id = i.tracker_id
    JOIN pm.issue_statuses s ON s.id = i.status_id
    JOIN pm.issue_priorities pr ON pr.id = i.priority_id
    WHERE i.assigned_to_id = (SELECT id FROM me) AND s.is_closed = false
    ORDER BY i.updated_at DESC LIMIT 50
  ),
  my_reported AS (
    SELECT
      i.id, i.number AS "number", p.key AS "projectKey", i.subject,
      p.identifier AS "projectIdentifier",
      s.name AS "statusName", s.color AS "statusColor",
      i.updated_at AS "updatedAt"
    FROM pm.issues i
    JOIN pm.projects p ON p.id = i.project_id
    JOIN pm.issue_statuses s ON s.id = i.status_id
    WHERE i.author_id = (SELECT id FROM me) AND s.is_closed = false
    ORDER BY i.updated_at DESC LIMIT 20
  ),
  watched AS (
    SELECT
      i.id, i.number AS "number", p.key AS "projectKey", i.subject,
      p.identifier AS "projectIdentifier",
      s.name AS "statusName", s.color AS "statusColor",
      i.updated_at AS "updatedAt"
    FROM pm.watchers w
    JOIN pm.issues i ON i.id = w.issue_id
    JOIN pm.projects p ON p.id = i.project_id
    JOIN pm.issue_statuses s ON s.id = i.status_id
    WHERE w.user_id = (SELECT id FROM me)
    ORDER BY i.updated_at DESC LIMIT 20
  ),
  recent AS (
    SELECT
      a.id, a.kind, a.title, a.body, a.created_at AS "createdAt",
      a.ref_id AS "refId", a.project_id AS "projectId",
      p.name AS "projectName",
      a.user_id AS "userId",
      u.login AS "userLogin"
    FROM pm.activities a
    LEFT JOIN pm.projects p ON p.id = a.project_id
    JOIN pm.users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT 15
  )
  SELECT json_build_object(
    'me',          (SELECT row_to_json(me) FROM me),
    'myAssigned',  COALESCE((SELECT json_agg(t) FROM my_assigned t), '[]'::json),
    'myReported',  COALESCE((SELECT json_agg(t) FROM my_reported t), '[]'::json),
    'watched',     COALESCE((SELECT json_agg(t) FROM watched t),     '[]'::json),
    'recent',      COALESCE((SELECT json_agg(t) FROM recent t),      '[]'::json)
  ) AS data
    `,
  )) as unknown;
  const [first] = extractRows(result);
  const data = (first as {
    data?: (MyPagePayload & { me: MyPagePayload['me'] | null });
  }).data;
  if (!data?.me) return null;
  // Each CTE's projection is COALESCEd to '[]' on the SQL side, so the
  // arrays are guaranteed non-null here.
  return {
    me: data.me,
    myAssigned: data.myAssigned,
    myReported: data.myReported,
    watched: data.watched,
    recent: data.recent,
  };
}
