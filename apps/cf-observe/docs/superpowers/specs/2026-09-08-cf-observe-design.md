# CF Observe v0.1 design

## Approved intent
A copy-in project for an existing personal Cloudflare Workers repository. No VPS or
self-managed database. Preserve received logs, traces and metrics in private R2;
show newly received events without waiting for an Iceberg commit. Workers Paid is
available. Target approximately one second, not an end-to-end latency guarantee.
The target repository was not accessible in this environment; this is an isolated
folder, not a patch against an inspected checkout.

## Selected design
An authenticated Worker handles OTLP/HTTP, a SQLite-backed Durable Object durably
buffers incoming requests, and an R2 writer persists gzip NDJSON segments plus
hourly manifests. Hibernating WebSockets deliver event previews immediately after
durable receipt. UI rendering is coalesced to at most once per second.

The default R2 flush interval is 10 seconds, independently configurable to 1 second.
The DO is temporary storage, NOT memory-only and NOT the permanent archive. This
is an explicit improvement over the prior conversation's volatile buffer. A receipt
means temporary durable acceptance; the health API separately reports R2 persistence.

No sampling is performed. Raw OTLP request content is preserved semantically; binary
requests also retain original protobuf bytes. Query limits paginate rather than delete
or silently sample. Unsupported protocols and oversized requests are rejected.

## Storage/consistency contract
One configured dataset, one writer DO, one private R2 bucket. Each flush job has
stable batch IDs, stable object key and stable sequence boundaries recorded before
R2 I/O. Ordering: write segment -> write manifest -> delete pending rows. Retries
reuse the job. A failed R2 operation leaves the durable pending data intact. A bounded
backlog returns retryable 503 rather than discarding data. A minute cron repairs a
missing alarm. No global interval loop, no R2 LIST during normal browsing.

The query path obtains pending metadata before reading R2 manifests, closing the
pending-to-archive transition race. Keyset cursors are signed and bind to filters and
a fixed sequence watermark. Reconnect opens the WebSocket before history fetch and
deduplicates by event ID. HTTP export retries without Idempotency-Key may duplicate
records; this is at-least-once ingestion, not a universal exactly-once claim.

## Scope
OTLP logs/traces/metrics explorer, JSON/protobuf decoding, raw event details, trace
correlation, loaded-result metric plotting, bounded paginated history, JSON export,
private authenticated UI, deployment examples, tests and cost worksheet.
No PromQL, distributed search index, alert engine, profiles, guaranteed 1-second SLA,
or transparent full-history SQL. Iceberg/R2 SQL is documented as an optional next
stage rather than misrepresented as already deployed. Default queries pay no R2 SQL
scan fees, but DO/Worker compute and R2 operations are still metered.

## Security
Separate ingestion and viewer secrets; authentication before storage access; signed
HttpOnly/SameSite cookies; same-origin WebSockets; no tokens in URLs or browser
persistent storage; private R2; CSP; bounded request/decompression/query work; no
payload logging. The operator must redact sensitive payloads at the source. This
single-tenant tool is not an untrusted multi-tenant observability SaaS.
