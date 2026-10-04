# Telemetry sources and freshness

## OpenTelemetry SDK directly
Point an OTLP/HTTP exporter to the Worker origin; logs, spans and metric points use separate standard paths. **gRPC is not accepted by this application.** Configure `http/protobuf` or `http/json` where supported by the SDK.

```text
OTEL_EXPORTER_OTLP_ENDPOINT=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20YOUR_INGEST_TOKEN
OTEL_SERVICE_NAME=my-service
OTEL_BSP_SCHEDULE_DELAY=1000
OTEL_BLRP_SCHEDULE_DELAY=1000
OTEL_METRIC_EXPORT_INTERVAL=10000
OTEL_BSP_MAX_EXPORT_BATCH_SIZE=128
OTEL_BLRP_MAX_EXPORT_BATCH_SIZE=128
```

The OTLP header environment-variable format may require percent-encoding; use the SDK's configuration object `{Authorization: "Bearer ..."}` when appropriate. Verify the installed SDK actually supports each environment variable. Never store these values in the public repo.

Logs/traces at one-second export cadence is a starting point; metrics default here to 10 seconds to avoid sending many mostly unchanged points. Set the metric interval to 1000 only when that resolution is needed. Large batches/records may still exceed the server limits, regardless of the record-count batch setting.

If a source samples spans or drops queued logs, this backend cannot recover them. Configure sampling intentionally (for example `OTEL_TRACES_SAMPLER=always_on` where supported) rather than assuming every source sends every event. Keep application-owned retries/durable buffering when loss is unacceptable.

A span is normally exported after it ends. To watch a running long task, send separate `task.started`, `task.progress`, and `task.completed` log/events with a shared trace or task identifier. Redact credentials and sensitive content before export.

## Plain JSON
`examples/publish.mjs` implements bounded retries with a stable Idempotency-Key for one export. Supply a stable key from your own durable job when retries must survive a caller restart.

```javascript
import {publishEvents} from './examples/publish.mjs';
await publishEvents({
  url: process.env.OBSERVE_URL,
  token: process.env.INGEST_TOKEN,
  events: [{
    service: 'automation', severity: 'INFO',
    message: 'report generation completed',
    timestamp: new Date().toISOString(),
    attributes: {task_id: 'your-task-id', duration_ms: 321}
  }]
});
```

`examples/worker-instrumentation.js` shows a Worker caller. Awaiting the telemetry call makes delivery errors visible to the business request. `ctx.waitUntil(...)` avoids waiting in the response path but does not create a durable retry queue. Choose those semantics explicitly; do not silently turn an audit requirement into best-effort logging.

## Existing Collector
`examples/otel-collector.yaml` is optional, not a backend dependency. It binds receiver ports to localhost, batches for one second and exports OTLP/HTTP to the Worker. Validate it against the installed Collector distribution. Its in-memory sending queue does not survive host restarts; file_storage can provide a persistent queue in compatible distributions.

## Cloudflare native Workers telemetry
Cloudflare's native OTLP export is another possible source for Worker logs/traces. Its own export buffering and supported signals are outside this project's control. Do not claim one-second end-to-end visibility by changing this backend alone. Direct application instrumentation is preferable for explicit immediate progress events. Custom metrics can be sent through an SDK or `/api/ingest`; this application is not a Prometheus scraper.

## Fidelity
OTLP requests are decoded and credential-filtered before storage. New protobuf requests omit original wire (`rawWireOmitted:true`) because the decoder cannot inspect unknown fields. Known logs, spans, gauge, sum, histogram, exponential histogram and summary fields are decoded; filtered attributes, exemplars, resource/scope and nanosecond string values remain inspectable. Views use milliseconds. Existing archives are not rewritten by this policy change.

No exhaustive certification against all SDKs or future OTLP versions is claimed. Protobuf success follows the empty Export*ServiceResponse format. OTLP errors use google.rpc.Status JSON/protobuf; temporary journal failures return503 with Retry-After. Verify exporter retry behavior and handle permanent oversized/invalid batches explicitly. For the tested Tail and direct publisher paths, read [Collector setup](../collectors/README.md).

## Primary documentation
- https://opentelemetry.io/docs/specs/otlp/
- https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- https://github.com/open-telemetry/opentelemetry-collector/tree/main/exporter/otlphttpexporter
- https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
