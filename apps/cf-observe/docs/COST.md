# Cost model · 2026-09-08 reference

No database VM or always-on managed ClickHouse service is required. This does **not** make all cloud charges zero: billable dimensions include R2 storage/operations, Worker requests/CPU, DO requests/duration, SQLite rows and temporary stored data. The Workers Paid subscription is assumed already present.

## Main trade-off: live latency ≠ object flush frequency
A received export is durably buffered and pushed live. The default R2 flush target is 10 seconds. Each successful nonempty flush writes one compressed segment and updates one hourly index: **two Class A PUT operations**, plus one index GET. No data means no segment writes. A one-minute cron may call the journal for recovery but does not list/scan R2 when idle.

Assume continuous nonempty operation for 30 days, no failures, each flush fits the 64-batch/4-MiB job cap, and sufficient throughput. These are explicit hypothetical counts, not a production measurement.

| R2 flush interval | Flushes/month | Class A PUTs | Class A charge with otherwise-unused 1M allowance |
|---|---:|---:|---:|
| 10 seconds | 259,200 | 518,400 | $0 |
| 1 second | 2,592,000 | 5,184,000 | $22.50 |

Cloudflare's documented Standard pricing is $4.50 per million Class A, $0.36 per million Class B and $0.015 per GB-month. Monthly included usage is 1M A, 10M B and 10 GB-month. **Billable usage is rounded up to the next billing unit**, so the 1-second example's 4.184M excess A operations are charged as five million, not fractionally. All free allowances are account-shared. Read live pricing before deployment.

An average billable storage measure of 100 GB-month gives `(100 - 10) × 0.015 = $1.35` when that storage allowance is unconsumed. Cloudflare derives its storage metric from daily peak storage over the billing month. This is not a quote for “100 GB ingested per month”: compression, accumulated retention, stored decoded payloads and index metadata affect actual stored bytes. New ingestion stores credential-filtered decoded payloads and omits protobuf wire bytes; older archived records may still contain wire copies because the policy does not rewrite history.

`npm run cost -- --flushSeconds=10 --averageGB=100 --extraReads=100000` calculates R2 only. Set `--freeA=0 --freeB=0 --freeGB=0` when other apps already consume the allowances. `--activeSeconds=288000` models eight hours of nonempty input over ten days. Large traffic, recovery retries or hourly boundary splits can create more flushes than this estimate.

## Scan savings, accurately stated
This version does not call R2 SQL, so it creates no R2 SQL billed scanned bytes. R2 Standard itself has no per-GB retrieval fee, but GET operations and the Worker CPU performing JSON filtering are metered. Known hourly index keys avoid R2 LIST during normal history queries. Explicit archive inspection performs one bounded LIST, which is Class A, and one index GET for the requested hour. Service/kind/received-time metadata prunes irrelevant segments; arbitrary message search still has to decompress candidate files.

No periodic R2 polling is used for Live; WebSockets push new previews. Initial/reconnect/manual queries still read history. Loaded-result charts reuse those same fetched previews, instead of issuing a separate query for every panel. Full raw details are fetched only on request. Results deliberately show whether all pages were examined.

Gzip is a compression convenience supported natively by Workers; this format is not Parquet and has no column pruning or inverted text index. An R2 GET-heavy raw explorer is not automatically cheaper than R2 SQL for repeated huge analytical queries. At scale, compare actual meters and add compaction/Iceberg only with benchmarks.

## Durable Object costs still matter
Durable acceptance, retries, health and WebSocket connections consume DO work. Ingestion is stored as a row per **export batch**, not a row per individual log. The configured DO supports hibernating WebSockets; inactivity can avoid duration charges, while active processing remains billable. Incoming requests/alarms, rows read/written and deletes are separate dimensions. Included usage is shared with other DO applications; one second exports on many clients can add up.

No estimate of total DO bill is asserted without an actual traffic profile, batch sizes, request count and measured active duration. The project has request/work/backlog limits but no automatic hard dollar cap. Protect the endpoint and monitor account usage. A publicly reachable Worker can incur request charges for unauthorized traffic even though authentication prevents storage access.

## Sources
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
