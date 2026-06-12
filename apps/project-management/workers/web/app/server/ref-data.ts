// Module-level cache for static reference data.
//
// trackers, issue_statuses, issue_priorities and roles are tiny (≤ 10 rows
// each) and only change via DBA-level seeds.  We hit them on almost every
// loader (issue page, project page, my page) — caching for 60 s saves four
// Hetzner round-trips per request.
//
// Cache is keyed only on time (TTL_MS) because the rows are global to the
// schema; there is no per-tenant variation.  The cache lives in the isolate
// memory, so each freshly-warmed worker pays one cold lookup, after which
// every subsequent request inside the 60 s window is free.

import { type DB } from '@allenlabs/pm-core/db/client';
import {
  issuePriorities,
  issueStatuses,
  roles,
  trackers,
} from '@allenlabs/pm-core/db/schema';

export type Tracker = typeof trackers.$inferSelect;
export type IssueStatus = typeof issueStatuses.$inferSelect;
export type IssuePriority = typeof issuePriorities.$inferSelect;
export type Role = typeof roles.$inferSelect;

export interface RefData {
  trackers: Tracker[];
  statuses: IssueStatus[];
  priorities: IssuePriority[];
  roles: Role[];
}

const TTL_MS = 60_000;

let cache: { data: RefData; at: number } | null = null;

export async function getRefData(db: DB): Promise<RefData> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  const [trackerRows, statusRows, priorityRows, roleRows] = await Promise.all([
    db.select().from(trackers),
    db.select().from(issueStatuses),
    db.select().from(issuePriorities),
    db.select().from(roles).orderBy(roles.position),
  ]);
  const data: RefData = {
    trackers: trackerRows,
    statuses: statusRows,
    priorities: priorityRows,
    roles: roleRows,
  };
  cache = { data, at: now };
  return data;
}

// Test helper — drop the cache between tests.  Not exported as a stable API.
export function _clearRefDataCacheForTests(): void {
  cache = null;
}
