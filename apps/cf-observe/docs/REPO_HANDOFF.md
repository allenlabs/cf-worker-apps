# Copy-in handoff for the repository agent

Historical instructions shipped with the source ZIP. The target is now
`allenlabs/cf-worker-apps`, app `apps/cf-observe`, and the deployment config is
`workers/web/wrangler.toml`. The root `CLAUDE.md` takes precedence: commit/push
directly to main, with no routine PR. See INTEGRATION_VERIFICATION.md for current checks.

## Task
Add the provided `cf-observe` project to the user's personal “cf public workers” repository following the **actual checkout's** layout. No exact owner/repository URL, root workspace structure or remote branch was verified by the package author. Do not substitute a different remembered repository name.

## Required sequence
1. Read repository AGENTS.md and inspect package/workspace/deployment conventions. Choose an app directory (suggestion: apps/cf-observe); do not restructure unrelated apps.
2. Copy this complete folder, preserving relative imports, `public`, SQLite migration and Wrangler bindings. Align lint/format/package-manager conventions without changing behavior.
3. Install development dependencies, review and commit the generated lockfile using the repository's package manager. Run tests and syntax check. Then run actual Wrangler dry-run and local workerd/Miniflare tests; those runtime checks were unavailable in the authoring environment.
4. Review fetch-based TelemetryJournal registration, SQLite storage synchronization, alarms, compressed R2 objects, WebSocket hibernation/attachments and origin/session behavior under workerd.
5. Deploy **staging only with the user's authorization**, a new private bucket and isolated DO namespace. Set distinct random secrets outside git. Run the included smoke script and a real browser against the deployment.
6. Exercise an actual OTLP SDK/Collector for JSON/protobuf success and failure/retry paths. Record payload-size behavior and p50/p95 event-to-screen latency. Do not claim one-second SLA from the local fixture tests.
7. Load-test the user's expected batch/second and bytes/second; measure Worker CPU, DO wall time/rows, R2 requests and backlog before expanding traffic.
8. Open a PR with changes, verified results and remaining limitations. Do not overwrite or delete existing telemetry, deploy production or publish secrets as part of copy-in.

## Non-negotiable contracts
R2 is permanent source storage; DO SQLite is a temporary durable outbox. Acknowledgment/broadcast occur after durable acceptance. Stable R2 job keys and data->manifest->pending-delete ordering must remain. No memory-only success ack, no deletion on failed R2 writes, no silent pagination truncation, no stale 90-second cutover assumption. Default 10-second R2 batching is independent from one-second live display; preserve that distinction.

## Current behavior and remaining limitations
No R2 SQL/Iceberg/Pipelines mode; no true full-text index, PromQL, alerting, durable client exporter queue, managed retention or independent backup. Single writer per dataset and no measured throughput envelope.

New ingestion stores the decoded payload after best-effort credential filtering. Protobuf wire bytes are omitted because unknown fields cannot be inspected by that filter; unknown protobuf fields cannot be recovered from the archive. This policy does not rewrite older archived data and is not a general PII detector. OTLP failures use HTTP status codes with `google.rpc.Status`-compatible JSON or protobuf bodies matching the request Content-Type. Retryable 429/502/503/504 responses include `Retry-After`.

Ingestion credentials can be assigned per source. Viewing still uses a shared viewer token or its session; there are no fine-grained multi-user roles.
