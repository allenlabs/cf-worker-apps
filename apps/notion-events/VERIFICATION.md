# Verification — 2026-10-25

All source data, grants, signatures, API responses, DNS answers and callback receivers in these checks are synthetic. No cloud resources, real subscriptions, credentials or production data were created or connected.

| Check | Observed result |
| --- | --- |
| Notion adapter, queue/SQLite regressions and safety unit tests | 31 passed, 0 failed |
| New bundled Worker in Miniflare/workerd | 14 verification groups passed |
| Shared protocol helper unit tests | 11 passed, 0 failed |
| Existing Channel Talk bundled Worker regression | 6 verification groups passed, before and after extraction |
| Both apps' JavaScript syntax checks | Passed |
| Both apps' Worker dry-run builds | Passed |
| Actual workerd coverage request | Unavailable: `Profiler is not enabled`; command exits 2 |

The new app uses the existing MCP server's Node/Miniflare test pattern, including real SQLite Durable Objects and complete OAuth PKCE flows, rather than introducing another runner. The unit SQLite checks exercise production queue methods, with only the unused Cloudflare entrypoint base stubbed. They are distinct from actual Worker runtime verification. No whole-Worker coverage percentage or TypeScript compilation is claimed for these JavaScript apps. Wrangler 4.147.0 and its installed Miniflare runtime were used for the final checks.

Runtime checks cover signed raw source capture, exact page and owner boundaries, self-author filtering, deduplication with changed Notion attempt metadata, retained raw receipts, restart recovery, delayed enrichment, permanent and transient failures, callback signing, stable retry bytes, retained `410` failures, manual recovery, paginated failure inspection, complete Unicode archive recovery, escaped response budgets, grant lookup failure, fresh-grant replacement, verification rejection, unsubscribe races and queued revocation. Additional unit regressions cover other integration writer exclusions and changed source settings before queued delivery.

The Cloudflare OS feature tree based on `34209e4` was independently rechecked: wrapper 132/132 with no skips, backend 765/765, frontend 507/507, MCP 35/35, authentication checks and five Worker dry-runs passed. Its full configured check exited zero. Full upstream lint still reports the same 127 existing errors in 27 files; diagnostic comparison found no newly introduced errors.

Repository-wide tests that call deployed services were not run. Live Notion permissions and event delivery, initial token bootstrap, live OpenAI callback acceptance, Native Agent Memory indexing, deployment and production resource setup remain unverified. See [activation requirements and DNS limitations](README.md#private-configuration-and-activation).
