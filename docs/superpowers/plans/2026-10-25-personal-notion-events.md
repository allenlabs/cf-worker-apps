# Personal Notion Events Implementation Plan

**Goal:** Add an isolated personal Notion comment relay and consolidate verified requested OS features without triggering unauthorized deployment.

**Architecture:** Independent Worker, owner OAuth KV, SQLite subscriptions/inbox/outbox/archive. Extract existing generic protocol helpers without changing the Channel Talk installation contract.

**Tech Stack:** Worker JavaScript, existing OAuthProvider, SQLite Durable Objects, Node tests and Miniflare.

**Spec:** `docs/superpowers/specs/2026-10-25-personal-notion-events.md`

## Global constraints

Use MCP 2026-07-28 and current documented Notion API fields. Preserve source bytes, archives, branch refs and all existing requested functionality. Use synthetic fixtures only. No deployment, credentials, live connection, resource creation, branch deletion or force push.

## Review focus

- Revocation or unsubscribe during callback verification must prevent stale activation.
- Duplicate source IDs with conflicting bytes must not overwrite archives.
- Enrichment or delivery failures must retain raw and enriched evidence.
- Exact page scope must not expand through block parents or malformed cursors.
- Unicode boundaries and oversized events must remain fully recoverable.

### Task 1: Inventory and reconciliation

- [x] Fetch all heads; compare branches, open PRs, authors and requested feature evidence.
- [x] Inspect main deployment triggers and record any inaccessible coupling.
- [x] Record a feature matrix, preserving unfinished and unrelated work.

### Task 2: Generic protocol reuse

Files: `apps/mcp-events/workers/api/{index,protocol,oauth}.js`, `tests/workers/shared.test.mjs`.

Interfaces: `protocol.js` exports existing byte/signature/callback helpers; `ownerConsent(request, env, {scope, productName, description, metadata})` returns a Response.

- [x] Run existing Channel Talk baseline; add shared helper regressions.
- [x] Extract helpers and consent unchanged; rerun Channel Talk tests and coverage attempt.

### Task 3: Notion source adapter

Files: `apps/notion-events/workers/api/notion.js`, `tests/notion.test.mjs`.

Interfaces: `sourceConfig(env)`, `verifySourceSignature(bytes, signature, token)`, `normalizeSource(payload, config)`, `hydrateComment(source, env, fetcher=fetch)`.

- [x] Write and observe failing signature, page scope, self-author and full-text tests.
- [x] Implement raw signature verification and exact signed source validation.
- [x] Implement bounded fixed-endpoint enrichment with explicit retry classification; run adapter tests.

### Task 4: Durable personal relay

Files: `apps/notion-events/workers/api/{index,relay}.js`, Wrangler example, package scripts and `tests/workers/check.mjs`.

Consumes Tasks 2 and 3. Produces independent OAuth MCP endpoint and Notion ingress, with no operational bindings to existing apps.

- [x] Add failing end-to-end OAuth/discovery/subscription/ingress/archive tests.
- [x] Add SQLite inbox, canonical archives, outboxes, terminal statuses and owner-scoped archive reads.
- [x] Add signed challenge and delivery, public DNS guards, grant rechecks, bounded retries and safe manual retry tool.
- [x] Provide paginated failure inspection and explicit cross-integration author exclusions, including queued callbacks.
- [x] Verify restart, callback race, failure ledger, deduplication, UTF-8 pagination and oversized archive recovery.

### Task 5: Verification and integration

- [x] Run both app suites, syntax/type checks, coverage attempts and dry-run bundles.
- [x] Run OS wrapper and full configured check; report any baseline lint failures separately.
- [x] Review public diff and history; resolve material findings with regression tests.
- [ ] Commit/push verified work, recheck remote main and integrate only if deployment coupling is safe. Retain feature refs. Check remote checks to terminal or verified absence.

## Execution record

- 2026-10-25: Existing checkout clean at 34209e4. Remote has main d2d2414 and feature 34209e4, four requested commits ahead and zero behind. Open PRs: zero. No additional active branches found.

- Verification: new app 31 unit tests and 14 Worker groups, shared helpers 11 tests, existing Channel Talk 6 Worker groups; both syntax/dry-run builds passed. Full OS check passed (132 wrapper, 765 backend, 507 frontend, 35 MCP, five dry-runs). Existing upstream lint remains 127 unchanged errors; Worker coverage profiler is unavailable.
- Decisions: source receipts distinguish changed Notion retry metadata from conflicting event identities; failure inspection is paginated; explicit writer exclusions cover automation using a different integration; source settings are rechecked before queued delivery.
