// Pure helpers for the Kanban board. Kept free of any Cloudflare/runtime deps
// so they stay at 100% unit coverage.

export interface StatusColumn {
  id: number;
  name: string;
  color: string;
  isClosed: boolean;
}

/**
 * Bucket issues into one column per status, preserving the status order passed
 * in. Each issue lands in exactly the column matching its `statusId`; issues
 * whose status isn't in `statuses` are dropped (defensive against stale rows).
 */
export function groupIssuesByStatus<T extends { statusId: number }>(
  issues: T[],
  statuses: StatusColumn[],
): Array<StatusColumn & { issues: T[] }> {
  const byStatus = new Map<number, T[]>();
  for (const issue of issues) {
    const list = byStatus.get(issue.statusId);
    if (list) list.push(issue);
    else byStatus.set(issue.statusId, [issue]);
  }
  return statuses.map((s) => ({ ...s, issues: byStatus.get(s.id) ?? [] }));
}
