# Durability, retries and operations

## Receipt contract
1. Validate authentication, protocol, payload bounds and event count.
2. Ensure a wakeup alarm is scheduled.
3. Insert the complete decoded export and receipt into a synchronous SQLite transaction.
4. Wait for storage synchronization; only then acknowledge and send live previews.
5. Persist a stable R2 job key and sequence range in DO metadata before external I/O.
6. Write gzip segment, then its hourly manifest entry.
7. Delete pending rows only after both R2 writes succeeded; publish persisted watermark.

The temporary source of truth is DO durable storage, not volatile JavaScript arrays. R2 is the permanent archive. A crash before receipt can leave either no record or an accepted record whose response was lost; callers must retry with an Idempotency-Key when they need duplicate suppression. Generic OTLP retries without such keys are at-least-once.

## Failure cases
- Segment PUT fails: keep the pending export and stable job; retry.
- Manifest PUT fails after segment succeeded: keep the pending export, retry the same segment key and replace/add one manifest entry. An orphan segment is possible until recovery, not loss of accepted data.
- Crash after R2 writes but before local cleanup: replay uses the same job; the index entry is keyed by the same segment key.
- Browser disconnects: reopen Live and query history; event IDs deduplicate overlapping results. A history snapshot is not a promise that WebSocket frames never drop.
- Batch moves during history query: snapshot pending metadata before manifest reads; refresh archive lookup if the pending row disappeared.
- Backlog fills: default 16 MiB or 256 pending exports triggers retryable 503. Accepted data stays intact; no arbitrary oldest-row eviction. The sender must not discard the rejected batch.
- R2 remains unavailable: exponential retry to 60 seconds plus a once/minute recovery kick. An extended outage eventually applies backpressure. This is not unlimited buffering.

A target interval of 1s or 10s is not a maximum latency guarantee. DO alarms can be delayed by maintenance/failover. Reading the durable pending buffer is what avoids waiting for an archive alarm during normal use.

## Invariants and maintenance
One configured dataset prefix has exactly one writer DO. Sequence numbers remain in its SQLite database after pending rows are removed. Never reset that database or attach a fresh DO namespace to an existing dataset prefix without a migration/rebuild design. Protect both the temporary storage and R2 account from accidental deletion.

Manifests are single-writer object replacements. Do not permit unrelated code or another deployment to overwrite them. Data keys use UUID and sequence range; timestamp paths use **receipt UTC hour**, not client event time, so delayed telemetry remains discoverable by ingestion time.

There is no automated retention or compaction in v0.1. Keeping all data increases long-term storage cost. To remove history, design an authenticated maintenance process that changes indexes and data consistently, supports concurrent readers and records what was deleted. Applying a lifecycle rule only to `.gz` objects leaves broken manifests; queries correctly fail rather than silently pretending records never existed.

R2 object deletion/account compromise is not solved by this outbox. No independent-account/offsite backup is configured. The tests simulate storage faults; they are not a cloud fault-injection or disaster-recovery certification.

## Primary documentation
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/r2/reference/consistency/
