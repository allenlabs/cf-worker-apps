# webhook-relay

A two-worker app that demonstrates the **multi-worker + Queue + Workflow**
pattern on Cloudflare.

```
                  ┌──────────────────┐                ┌────────────────────┐
POST /hooks/foo → │ webhook-ingest   │── EVENTS Q ──▶ │ webhook-relay      │
                  │ workers/ingest/  │                │ workers/relay/     │
                  └──────────────────┘                └────────────────────┘
                          ▲                                    │
                  KV: SUBSCRIBERS                              ▼
                  (per-source list)                  ┌────────────────────┐
                                                     │ RelayWorkflow      │
                                                     │ (retry + backoff)  │
                                                     └────────────────────┘
                                                              │
                                              POST → each Subscriber.endpoint
```

## Pieces

| Worker | Trigger | Purpose |
|---|---|---|
| `workers/ingest` | HTTP `POST /hooks/:source` | Snapshot request body + safe headers, look up subscribers in KV, enqueue a `RelayJob` |
| `workers/relay`  | Queue consumer (`webhook-events`) | Each job spawns one **Cloudflare Workflow** run (`RelayWorkflow`) |
| `RelayWorkflow`  | Workflow steps | Per-subscriber delivery with `retries: { limit, delay, backoff: 'exponential' }` |
| `webhook-events-dlq` | Dead-letter queue | Receives jobs that exhausted `max_retries` at the queue level (above the workflow's per-subscriber retries) |

Each worker has its own `wrangler.toml`; both must be `wrangler deploy`-ed
(see `npm run deploy`).

## Subscribers

Subscribers are a JSON array stored in KV under `subscribers:<source>`:

```bash
wrangler kv key put --binding=SUBSCRIBERS 'subscribers:github' '[
  { "id":"slack-prod", "endpoint":"https://hooks.slack.com/services/…",
    "headerName":"X-Token", "headerValue":"…" }
]' --config workers/ingest/wrangler.toml
```

## Why two workers (not one)

- **Ingest must be fast**: the upstream caller (GitHub, Stripe, …) retries
  aggressively if you return slowly.  The ingest worker only writes one queue
  message and returns 202 — typical latency under 30 ms.
- **Relay can be slow**: outbound subscriber endpoints time out, retry,
  rate-limit.  Workflow makes that durable: a worker restart between steps
  resumes from the last checkpoint.
- **Quotas + permissions** scale per-worker.  In production you'd give the
  relay worker tighter outbound egress and bigger CPU limits than ingest.

## Tests

`npm run test` — unit tests for the pure helpers (`buildJob`, `loadSubscribers`,
`deliverOnce`).  Queue + Workflow execution is covered by `wrangler dev` in
the local Miniflare; add `tests/workers/` integration tests with
`@cloudflare/vitest-pool-workers` and `queueProducer`/`workflowEntrypoint`
bindings as needs grow.
