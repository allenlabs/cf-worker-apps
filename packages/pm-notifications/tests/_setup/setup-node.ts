import { beforeEach } from 'vitest';
import { _clearRefDataCacheForTests } from '@allenlabs/pm-core/server/ref-data';

// createIssueImpl (used to seed) resolves default status/priority from the
// module-level ref-data cache; clear it before each test so we hit the test DB.
beforeEach(() => {
  _clearRefDataCacheForTests();
});
