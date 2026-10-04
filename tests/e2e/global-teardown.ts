/**
 * Playwright global-teardown: DELETE every e2e-tagged row.  Runs after the
 * whole suite, even if individual specs failed (Playwright invokes
 * globalTeardown unconditionally after a non-fatal run).
 */

import { cleanup } from './lib/cleanup';

export default async function globalTeardown(): Promise<void> {
  try {
    const results = await cleanup();
    const total = results.reduce((a, r) => a + r.rows, 0);
    // eslint-disable-next-line no-console
    console.log(`[e2e:teardown] cleaned up ${total} row(s) across ${results.length} table(s)`);
  } catch (err) {
    // Don't mask a real test failure with a teardown failure — log and
    // exit clean.  Cleanup can be re-run by hand if it really matters.
    // eslint-disable-next-line no-console
    console.error('[e2e:teardown] cleanup failed:', err instanceof Error ? err.message : err);
  }
}
