# Conversation persistence

Configure `CONVERSATIONS` as a D1 binding and set the server-owned `TENANT_ID` and `TENANT_NAME`. Use a dedicated D1 database and dedicated Durable Object namespaces for each tenant deployment. Every D1 primary key and read predicate includes the configured tenant. Credentials, Assistant and GitHubAuthoring pin that tenant in their own Durable Object storage; changing the tenant on an existing namespace fails closed.

This implementation requires the paid D1 per-invocation query allowance. The public Wrangler database identifier is a placeholder, not a provisioned resource.

## Native execution with external persistence

`PiHarness` still opens its native Storage object and uses the installed native Harness, task executor, session APIs, registry, forks and usage calculations. Its factory delegates all 16 public Storage methods on that same object to `D1PiStorage` before `Harness.open`.

The adapter serializes commit admission and uses native `MemoryStorage.prepareCommit` to validate and detach each write. One atomic D1 batch persists the native commit journal and the history index; only then does the adapter apply the prepared memory mutation. A cold start verifies each journal checksum and replays those writes with their original sequence numbers. Resolved native document-copy writes are journaled, so replay does not depend on a mutable copy source.

A lost commit response is resolved by reading the exact sequence, SHA-256 checksum and payload on a primary D1 session. An unavailable or conflicting confirmation poisons that adapter. Channel and Git authoring callers reset the public PiHarness factory and leave the operation recoverable before reopening from D1. A committed admission retains its operation ID, account and configuration snapshot, preventing another model admission on replay.

New conversation commits write zero `pi_entries` rows in Durable Object SQL. The old native tables remain a frozen legacy backup. Operational account credentials, jobs, selected session state, Git drafts, CAS write receipts and uncertain publication receipts remain in their existing Durable Objects.

## Legacy migration

Before cutover, the adapter reads every native metadata, record-ID, conversation, entry, task, submission, document and document-revision row. It archives the complete raw SQL snapshot as ordered checksum-verified D1 chunks. This snapshot preserves burned IDs, sequence floors and data unavailable through current public reads.

The importer reconstructs native observable records at their original sequences. Current-only documents whose SQL revisions have already been pruned receive a hidden base followed by the retained native bases; retired current-only documents retain their original retirement metadata. It does not invent unavailable historical content.

Each invocation admits at most 100 bootstrap/journal write statements, then returns `conversation_migration_pending`. The next attempt resumes after the verified journal's highest sequence. The source snapshot hash must remain unchanged throughout migration. Models and tools remain stopped until all writes are imported, replayed and compared with the original public reads, including scans, document membership, entry pages and fork cutoffs. Cutover requires a verified raw snapshot, a ready D1 stream and a durable `conversationMigration` receipt. No native transcript table is cleared.

Native workerd tests migrate 1,050 legacy entries in 32 attempts, including a runtime restart. A separate actual Assistant lifecycle test completes the same migration through 32 warm retries with zero model calls. The largest measured attempt performs 127 D1 statements, below the paid D1 limit.

Completed Channel receipts and their original observed staff text move to D1. Only after a durable receipt roundtrip does the operational ledger clear its raw event and answer. Legacy terminal receipts migrate ten at a time; already compacted rows are skipped on startup. Pending and uncertain delivery state remains recoverable. Authoring ask ledgers retain request hashes while their original prefixed prompt resides in D1.

## Explicit ceilings

| Bound | Value | Behavior |
| --- | --- | --- |
| Per-store retained native journal | 2,000 commits and 8 MiB | New commits fail before persistence; no truncation |
| One native commit | 1 MiB and 100 SQL statements | Reject before any SQL effect |
| Canonical index statement bindings | At most 96 | Bounded multi-row inserts |
| Cold journal replay | At most 22 D1 read statements | Verify before native execution |
| History page | 1–200 entries; at most 1 MiB of entry JSON | Explicit continuation cursor or oversized-entry error |

The native fixture's first simple mock reply uses **6 commits and 3,594 journal bytes**, including initial root setup. Consequently, 2,000 commits can represent only a few hundred simple exchanges, with fewer exchanges when tools, settings, forks or document changes add commits. This is a deliberate bounded replay implementation, not unlimited transcript retention. Raising the ceiling requires verified native checkpoints and a bounded hydration strategy; automatically pruning journal history would lose native recovery and document semantics.

At the ceiling, existing D1 transcripts remain available for inspection. Native mutations fail visibly rather than continuing with an incomplete execution context.

## Server contracts

`GET /api/conversations?kind=channel&limit=50&before=<cursor>` returns tenant metadata, observed conversation metadata and `nextCursor`. The cursor is a stable update-time/object-key pair. Git authoring streams are excluded from this shared Channel/manual listing.

`GET /api/threads/history?root=<observed-root>&session=<native-id>&limit=50&before=<entry-id>` and `/api/threads/export` return native canonical entries in ascending ID order, session metadata, and `pagination: {before, nextBefore, hasMore}`. Without `before`, the newest page is returned. Fork ancestry uses a recursive SQL query with a fixed seven bindings and respects each inclusive parent cutoff. Exports use the same page contract; iterate `nextBefore` to retrieve older pages.

Channel receipts include `messageId`, `operationId`, `state`, original `text`, `senderId`, `sourceTimestamp`, the pinned operational `snapshot`, and `manager: {managerId, displayName, state}`. Manager names are looked up only for server-observed sender IDs in the configured channel, with native credentials retained on the server. D1 caches only ID/name, scope and expiry metadata. Resolution failure produces an explicit fallback name and never blocks model generation. Native manager lookup fetches share the helper's abort signal.

History APIs expose only a minimal `{backend: "d1", tenantId}` storage label. They do not export bootstrap snapshots, native task/document state or credentials.

## Runnable checks

Run `npm --prefix apps/cloud-agent run storage-check` for the native Storage conformance and real workerd D1/DO fixture. It proves concurrent commits, ambiguous append recovery, poisoned-adapter reopening, zero new native transcript rows, restart/fork/replay/usage parity, 80-level ancestry paging, tenant isolation, immutable tenant pins, pre-effect size rejection, full legacy checkpoint preservation, and resumable cold/warm migration.

The ordinary `check`, `auth-check`, `admin-check`, `control-check` and `github-check` scripts include D1 bindings and keep their prior behavior checks. The Channel suite additionally proves a committed admission whose confirmation read fails still produces one model call and one reply with its original account/session snapshot.
