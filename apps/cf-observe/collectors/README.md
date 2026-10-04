# Cloudflare Workers collection

`cf-observe-tail` collects invocation outcomes, console messages and uncaught exception messages from explicitly connected producer Workers. It calls `cf-observe` through a Service Binding and uses a dedicated ingestion credential. It has no public HTTP endpoint, R2 bucket or Durable Object of its own.

## Connect a producer

From `apps/cf-observe`, deploy the receiver first, register a dedicated `workers-tail` token in its `SOURCE_TOKENS` secret, then deploy the Tail consumer:

```sh
npm exec wrangler -- deploy --config workers/tail/wrangler.toml
npm exec wrangler -- secret put INGEST_TOKEN --config workers/tail/wrangler.toml
```

Add this **top-level** setting to the producer's Wrangler config, above the first TOML section. Preserve any existing consumers:

```toml
tail_consumers = [{ service = "cf-observe-tail" }]
```

For a producer already deployed, a settings-only update can attach the consumer without redeploying the application code. Record the attachment in its tracked configuration as well, because later deployments use that configuration. Never attach the consumer to `cf-observe` or `cf-observe-tail`; both names are also excluded in code to prevent recursive collection.

Use the dashboard service filter to select a producer. A successful request produces a `Worker invocation ok` summary even when the application does not call `console.log`. Summary attributes contain HTTP method, pathname and response status where present, invocation outcome, console/exception counts and omitted-record counts. Non-HTTP invocations are represented without fabricated HTTP metadata.

## Redaction and bounds

The consumer constructs a new record for each event. It never stores the original TailItem, request headers, request body, `cf` properties, URL query/userinfo/fragment or exception stack. It redacts credential-like keys and text before transmission. Console output and exception messages remain readable, with up to 128 console records and 16 exceptions per invocation. Messages are limited to 8,192 characters with visible truncation markers. Summary counts disclose records omitted by those limits.

This is a credential filter, not a complete policy for personal or business data. Pathnames and arbitrary console text can contain application data. Avoid logging sensitive payloads at the producer and adapt `redactTelemetry` or the Tail converter's `sanitize` hook for each application's policy. The receiver's source policy is an additional storage boundary; raw inspection contains the sanitized export, not the original TailItem.

Cloudflare can truncate or omit data before the Tail handler receives it. Tail delivery occurs after a producer invocation finishes, so it does not reveal progress inside a long-running request. It does not create a durable sender queue, and this implementation makes four bounded attempts per export. It therefore does not promise lossless delivery through an extended receiver outage.

## Immediate progress events

Use the shared publisher for progress that should be visible while an operation is running. Add the producer Service Binding:

```toml
[[services]]
binding = "OBSERVE"
service = "cf-observe"
```

Set a dedicated `OBSERVE_INGEST_TOKEN` secret and use:

```js
import { publishEvents } from './path/to/cf-observe/src/collectors/publisher.js';

await publishEvents({
  binding: env.OBSERVE,
  token: env.OBSERVE_INGEST_TOKEN,
  idempotencyKey: `${persistedTaskId}:started`,
  events: [{
    service: 'my-worker', severity: 'INFO', message: 'task.started',
    timestamp: new Date().toISOString(), attributes: { task_id: persistedTaskId }
  }]
});
```

For Node or other fetch-capable hosts, pass `url: process.env.OBSERVE_URL` instead of `binding`. HTTPS is required except for local loopback development. `examples/publish.mjs` re-exports the same function.

The publisher sanitizes records, prevalidates the entire export and splits by actual serialized UTF-8 bytes (480 KiB) and record count (128). Individual records above 256 KiB or a total export above 8 MiB / 5,000 records fail before network I/O. It returns `{ events, batches, receipts }`. Retries reuse each chunk's identical body and key on network failures and HTTP 429/502/503/504, with a ten-second timeout per attempt. Other statuses fail immediately.

For retries across a caller restart, persist the same export ID, exact event data and publisher options. The receiver's receipt deduplication lasts 24 hours; replay after that window can duplicate events. If a later chunk fails, earlier chunks may already be accepted. Replaying the same export inside that window safely retries those chunks. Awaiting telemetry adds latency and failure semantics to the application operation; `ctx.waitUntil()` avoids waiting in the HTTP response but remains best effort. Important audit events need the application's own durable outbox.

## Personal hosts

The existing `examples/otel-collector.yaml` remains an illustrative, memory-backed configuration. No personal host Collector has been installed or validated by this Workers-focused change. A later host rollout should pin Collector Contrib, enable a persistent sending queue and file checkpoints, bind receiver ports to loopback, and verify restart/retry behavior against actual source paths.

## Official references

- [Tail handler data and redaction](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)
- [Tail Workers setup](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
- [HTTP Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
- [OTLP transient failure contract](https://opentelemetry.io/docs/specs/otlp/)
