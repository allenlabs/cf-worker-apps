import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDB, makeTestDb } from '../../src/testing/db';
import {
  _clearRefDataCacheForTests,
  getRefData,
} from '../../src/server/ref-data';

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
  _clearRefDataCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _clearRefDataCacheForTests();
});

describe('getRefData', () => {
  it('returns all four ref-data slices from a fresh cache', async () => {
    const data = await getRefData(db);
    expect(data.trackers.length).toBeGreaterThan(0);
    expect(data.statuses.length).toBeGreaterThan(0);
    expect(data.priorities.length).toBeGreaterThan(0);
    expect(data.roles.length).toBeGreaterThan(0);
    // shape checks
    expect(data.trackers[0]).toHaveProperty('id');
    expect(data.statuses[0]).toHaveProperty('isClosed');
    expect(data.priorities[0]).toHaveProperty('isDefault');
    expect(data.roles[0]).toHaveProperty('permissions');
  });

  it('serves cached data on a second call within the TTL window', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const first = await getRefData(db);
    // Wipe the DB rows underneath the cache.  If the cache works, the
    // next call still returns the original rows; if it does a fresh
    // SELECT, it'd come back empty.
    await db.execute('TRUNCATE pm.trackers, pm.issue_statuses, pm.issue_priorities, pm.roles RESTART IDENTITY CASCADE;');

    vi.setSystemTime(t0 + 1_000); // 1 s in — well within the 60 s TTL
    const second = await getRefData(db);
    expect(second).toBe(first); // same object reference
    expect(second.trackers.length).toBeGreaterThan(0);
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const first = await getRefData(db);
    expect(first.trackers.length).toBeGreaterThan(0);

    await db.execute('TRUNCATE pm.trackers, pm.issue_statuses, pm.issue_priorities, pm.roles RESTART IDENTITY CASCADE;');

    vi.setSystemTime(t0 + 61_000); // 61 s in — TTL has expired
    const second = await getRefData(db);
    expect(second).not.toBe(first);
    expect(second.trackers).toEqual([]);
    expect(second.statuses).toEqual([]);
    expect(second.priorities).toEqual([]);
    expect(second.roles).toEqual([]);
  });

  it('_clearRefDataCacheForTests() forces an immediate refetch', async () => {
    const first = await getRefData(db);
    _clearRefDataCacheForTests();
    await db.execute('TRUNCATE pm.trackers RESTART IDENTITY CASCADE;');
    const second = await getRefData(db);
    expect(second).not.toBe(first);
    expect(second.trackers).toEqual([]);
  });
});
