# Optional Iceberg / R2 SQL extension — NOT IMPLEMENTED

v0.1 stores gzip NDJSON plus manifests and has no Pipelines binding, Data Catalog or SQL execution route. Existing `.ndjson.gz` files are not automatically Iceberg tables. R2 SQL queries Iceberg tables registered in R2 Data Catalog; it cannot directly query this format merely because it is in R2.

The current choice keeps deployment small, avoids SQL scan charges and makes recent records inspectable without Iceberg commit latency. It trades off large historical query performance, column pruning and analytical aggregation.

For an extension, keep the live durable journal path unchanged. Derive normalized rows containing event_id, received_at, event_timestamp, service, kind, severity, trace_id, span_id, message, numeric metric fields and raw source locator. Export these through a **separate durable delivery state machine** into Pipelines -> Data Catalog/Iceberg. R2 raw archives remain recoverable source exports. Do not delete an export retry record merely because a Pipelines call accepted data; schema validation/visibility must be tested.

Large-range dashboard queries can use bounded SQL against Iceberg, while recent data is overlaid from the durable journal with event_id dedupe. Determine overlap from confirmed export/visibility watermarks and keep an explicit backfill procedure; do not assume “90 seconds is always enough.” Use server-side fixed query templates, time bounds and cache authorization isolation. Neither bearer credentials nor arbitrary SQL should be handed to a public browser.

Before making this a supported mode, implement and test schema creation/validation, export idempotency, retry after partial failure, source backfill, exact metric temporality, late arrivals, observed SQL visibility, cursor compatibility, retention/compaction, query bill limits and load measurements. This document is an extension boundary, not a claim those features exist in the delivered code.

Sources:
- https://developers.cloudflare.com/r2-sql/
- https://developers.cloudflare.com/r2-data-catalog/
- https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/
