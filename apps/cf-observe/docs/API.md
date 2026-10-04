# API v0.1

All requests use HTTPS in production. There is one dataset selected in deployment configuration. No dataset parameter is accepted from untrusted callers.

| Method/path | Auth | Body / result |
|---|---|---|
| POST `/v1/logs` | Ingest Bearer | OTLP ExportLogsServiceRequest |
| POST `/v1/traces` | Ingest Bearer | OTLP ExportTraceServiceRequest |
| POST `/v1/metrics` | Ingest Bearer | OTLP ExportMetricsServiceRequest |
| POST `/api/ingest` | Ingest Bearer | JSON object/array or NDJSON events; 202 receipt |
| POST `/api/session` | Viewer token in JSON body | `{token}` -> HttpOnly 8h session cookie |
| DELETE `/api/session` | Same-origin | Expire browser cookie |
| GET `/api/health` | Viewer Bearer or session | Backlog, R2 status, version |
| GET `/api/archive/check?hour=...` | Viewer Bearer or session | Read-only manifest/segment key inspection for one UTC receipt hour |
| GET `/api/events` | Viewer Bearer or session | Bounded history page |
| GET `/api/event` | Viewer Bearer or session | Full raw event and export batch |
| GET `/api/live` + WS upgrade | Viewer session; same-origin | Hello, events, persisted frames |
| GET `/healthz` | None | Version only, no telemetry/health details |

## Ingest
Content-Type: `application/json`, OTLP `application/x-protobuf`, or generic `application/x-ndjson`. Content-Encoding: identity or gzip. Maximum wire body 512 KiB, decompressed gzip body 1 MiB, decoded internal export 1.5 MiB, normalized events 2,000 per export. Reduce batch size when a limit is exceeded. No partial-success silent drop behavior is implemented: invalid batches fail as a whole.

Optional `Idempotency-Key` is at most 256 characters. Its digest is scoped to the authenticated source ID and retained for 24 hours by default (`RECEIPT_RETENTION_DAYS`: 1..30). Retries from the same source with the same key and filtered payload return the initial receipt; changed filtered payload returns 409. Source credentials are configured through `SOURCE_TOKENS`, with legacy `INGEST_TOKEN` support. Caller-supplied source IDs cannot override provenance. Without a stable key, exporter retries can create duplicate records. Event IDs are `batchUUID:index`, not a universal exactly-once guarantee.

Successful ordinary JSON exports receive a 202 JSON receipt with batchId, seq, duplicate, events and durability. Successful OTLP JSON returns `{}` with HTTP 200. Protobuf success is an empty protobuf body with HTTP 200. Receipt headers include `x-cf-observe-batch-id` and `x-cf-observe-durability`. Both mean temporary durable buffer acceptance, not R2 commit.

Temporary journal transport/storage failures return 503 and Retry-After. OTLP failures use `google.rpc.Status` in JSON or protobuf according to the request Content-Type. Retryable OTLP statuses are 429, 502, 503, 504. Invalid/oversized requests remain permanent failures; callers must reduce oversized batches before sending. Receiver filtering precedes durable acceptance and marks `redacted` and `redactionPolicy` on the stored batch.

## Query
Required `from` and `to` are epoch **milliseconds of server receipt**. Inclusive bounds. Optional `kind=logs|traces|metrics`, exact `service`, exact lowercase `traceId`, and case-insensitive substring `q` in the decoded raw event. Optional `limit` is 1..500, default 200.

A response contains `events`, `nextCursor`, `complete`, `watermark`, `scanned` and `timeBasis`. Supply the same filters, from/to and a returned cursor to continue. Cursors expire after one hour and bind to a fixed sequence watermark, so new ingestion does not reorder a history export.

A page can legitimately be empty with `complete:false` and a cursor: it exhausted its file/hour budget without finding a match. Never treat that as “no matching data exists.” The default page budgets are 24 hourly manifests, 12 segment/pending source reads and about 32 MiB of archive plain bytes; transition recovery may perform an additional bounded lookup. These are guardrails, not billed Cloudflare usage totals.

The UI keeps up to 10,000 previews in memory. `scripts/export.mjs` follows explicit page continuations and reports partial output as an error. `--raw=true` reads full details per matching event; this is more expensive and may repeat a shared export request. Exports create new files only.

## Raw detail
Pass `id`, `seq` and `receivedAt` from a preview. The API resolves the pending batch or its R2 segment even if it moved since the preview was created. Response includes `{event, storage, batch}`. New protobuf ingestion stores the filtered decoded request with `rawWireOmitted:true`; original wire bytes are omitted because unknown fields cannot be filtered. Existing archived v0.1 batches are not rewritten and may still contain historical wire bytes.

## Health and archive inspection

Health includes `sources` with trusted `sourceId`, `lastReceivedAt`, `acceptedBatches`, `acceptedEvents`, and `acceptedBytes`. Counters start with this feature deployment, survive DO eviction, and do not count duplicate retries. They are accepted telemetry totals, not platform billing. `maxPendingBytes`, `maxPendingBatches`, `pendingUtilization`, `nextRetryAt` and `rejectedBatches` describe backlog; the rejection counter covers journal 503 admission failures, not all edge authentication/validation failures.

Archive inspection accepts one epoch-millisecond `hour`, defaults to the previous UTC hour, and performs at most one LIST of 1,000 objects and one bounded manifest GET. `healthy`, `empty`, `warning`, `incomplete` distinguish outcomes. Missing references, unindexed files and invalid sequence ranges are reported; no object is deleted or repaired. Active or interrupted publication can produce temporary unindexed objects. An empty result cannot detect simultaneous loss of both the index and every raw object. This is a key/index check, not a payload checksum audit.

## Live frames
`hello` reports health. `events` carries filtered bounded previews after durable acceptance. `persisted` carries a `throughSeq` watermark after R2 segment/index writes. The browser merges duplicate IDs and marks persisted records. Sessions are checked on activity; expired sessions close the socket. Reconnect must fetch history, because WebSocket delivery alone is not durable storage or a guaranteed complete replay.
