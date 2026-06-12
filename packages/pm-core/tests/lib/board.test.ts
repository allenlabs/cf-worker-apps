import { describe, expect, it } from 'vitest';
import { groupIssuesByStatus, type StatusColumn } from '../../src/lib/board';

const statuses: StatusColumn[] = [
  { id: 1, name: 'New', color: '#fff', isClosed: false },
  { id: 2, name: 'In Progress', color: '#eee', isClosed: false },
  { id: 5, name: 'Closed', color: '#ddd', isClosed: true },
];

describe('groupIssuesByStatus', () => {
  it('buckets issues into one column per status, preserving order', () => {
    const issues = [
      { id: 1, statusId: 1 },
      { id: 2, statusId: 2 },
      { id: 3, statusId: 1 },
      { id: 4, statusId: 5 },
    ];
    const cols = groupIssuesByStatus(issues, statuses);
    expect(cols.map((c) => c.name)).toEqual(['New', 'In Progress', 'Closed']);
    expect(cols[0]!.issues.map((i) => i.id)).toEqual([1, 3]);
    expect(cols[1]!.issues.map((i) => i.id)).toEqual([2]);
    expect(cols[2]!.issues.map((i) => i.id)).toEqual([4]);
  });

  it('yields empty columns for statuses with no issues', () => {
    const cols = groupIssuesByStatus([], statuses);
    expect(cols.every((c) => c.issues.length === 0)).toBe(true);
  });

  it('drops issues whose status is not among the columns', () => {
    const cols = groupIssuesByStatus([{ id: 9, statusId: 999 }], statuses);
    expect(cols.flatMap((c) => c.issues)).toEqual([]);
  });
});
