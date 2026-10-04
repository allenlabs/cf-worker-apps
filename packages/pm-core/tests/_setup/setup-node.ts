// Node setup for pm-core's server tests.
//
// The ref-data cache is module-level (one map per isolate). Each test builds a
// fresh PGlite-backed DB, so a prior cache entry — keyed on time, not on DB
// instance — would happily serve rows that no longer exist. Wipe it before
// every test so we always hit the test's own DB.
import { beforeEach } from 'vitest';
import { _clearRefDataCacheForTests } from '../../src/server/ref-data';

beforeEach(() => {
  _clearRefDataCacheForTests();
});
