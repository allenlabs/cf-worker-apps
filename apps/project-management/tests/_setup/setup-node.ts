// Setup for the Node environment (server + pure-lib tests).
// Node already exposes TextEncoder, crypto.subtle, fetch and File globally, so
// no polyfills are needed.  We just want vitest's globals.
import { beforeEach } from 'vitest';
import { _clearRefDataCacheForTests } from '@allenlabs/pm-core/server/ref-data';

// The ref-data cache is module-level (one map per isolate).  Each test
// builds a fresh PGlite-backed DB, so the prior cache entry — keyed on
// time, not on DB instance — would happily serve rows that no longer
// exist.  Wipe it before every test so we always hit the test's own DB.
beforeEach(() => {
  _clearRefDataCacheForTests();
});
