# Native Agent Memory implementation plan

Goal: a single-user opt-in deployment automatically provisions its namespace, lazily creates a profile per stable bot ID, and ingests complete persisted text conversations without destructive clipping.

## Design decision
Use the native Workers binding, not a PAT or a new MCP connection. The documented API has no arbitrary tags. Profiles partition bots; deterministic session IDs group chats. No shared cross-bot fallback or dual write. Namespace creation belongs to the authenticated deployment process, never to model tools. Existing canonical chat/archive storage remains authoritative.

## Implementation
- [x] Test names, Unicode framing, durable ingestion cursors, retry identity, restart, deletion races and source failures first.
- [x] Implement a pure storage-backed native memory queue, using bounded archived pages and ACK-only progress.
- [x] Wire canonical message allocation, original-history recovery and the existing alarm arbiter; add scoped native recall/status tools.
- [x] Add single-user deployment validation, binding generation and safe GET/create/read-back namespace provisioning.
- [x] Explain automatic capture separately from optional recall in bot settings. Preserve existing profiles and snapshots.
- [x] Verify local tests, source/patch integrity and public diff. Publish only on feat/bdots-bot-workspaces after final verification; publication is reported by the resulting Git commit.

## Invariants and review focus
No message deletion, trimming or summary substitution. Invalid UTF-8 fails visibly. Freeze each batch before remote I/O; acknowledge only after ingest resolves; retain failed batches indefinitely with bounded backoff. Stable identity excludes bot names and revisions. Deletion cannot resurrect a local queue. Namespace or principal changes cannot silently retarget a queued batch. Do not publish installation identities or credentials. New/used private owner chats enroll; old unused workspaces are not scanned remotely. Binary attachment bytes remain in canonical storage because the API accepts text only.

## Verification boundary
This environment cannot resolve GitHub/npm hosts. Use connected GitHub reads/writes and executable dependency-free regression tests. Record native Workerd/build checks as unavailable unless actually run; do not imply that mocks establish a production deployment.
