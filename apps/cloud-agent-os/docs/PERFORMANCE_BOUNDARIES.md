# Performance boundaries

Measure the awaited operation before changing its scheduling or data contracts. A Worker invocation can include an entire WebSocket session. Agent tracing closes a model span after the completed response, and `agent.run.finished.durationMs` covers the whole turn. Neither measures first text arrival or browser paint. Existing error reporting does not measure route readiness.

| Path | Relevant boundaries | Existing measurement limits |
|---|---|---|
| Initial screen and navigation | Document and route chunks, WebSocket, server configuration, authentication pipeline, onboarding and identity, route RPCs, first subscription snapshot, paint | There are no route-ready or paint performance marks. Promise-pipelined RPCs must not be counted as serial round trips. Static chunk sizes do not establish download or parse latency. |
| Bot library | Authenticated identity, concurrent bot-list and main-bot requests, rendering | RPC spans may contain both caller and callee records; their count need not equal unique user requests. |
| Memory search | Authorized bot catalog, up to four source lookups at once, source attribution and full-result archival | A tool span includes preparation and archival. Partial lookup failures can return a structured result without failing the whole span. Native memory must be explicitly enabled before it can be involved in a live delay. |
| Saving and outbox | Canonical storage, durable pending batch, permission revalidation, profile lookup and ingest, ACK, cursor advance | Alarm success does not prove ingest or indexing success. The queue has retry/cursor status but no dedicated duration measurement. Background alarm time is not chat TTFT. |

## Archive resource lookup

An archived page first validates chat existence and its recorded access provenance. Missing or corrupt provenance fails explicitly. For a validated empty resource list, consulting the resource catalog cannot change the access decision. Avoid that unrelated AdminSettings RPC on each page. This also keeps an unprotected original readable during a resource-catalog outage.

For nonempty provenance, every page still loads the current resources and requires every referenced resource to be enabled. Lookup failures and revocation still fail closed. The caller's authenticated workspace capability, chat isolation, archive checks, Unicode boundaries, source text and cursors remain unchanged. This is not a permission cache.

The regression suite exercises real Workerd storage and Overseer methods: complete Unicode paging, resource-catalog outages, revoked and missing resources, disabled resources, missing or corrupt provenance, another chat and a deleted chat. It also verifies that protected reads still propagate a catalog failure.

## Controlled operation counts

A local queue/host/Overseer fixture with a local AdminSettings Durable Object uses a generated 200,000-byte Unicode message and a fake ingest binding. One eight-frame batch performs eleven resource-catalog reads before the change: one history page, eight prepared pages, and two pre-ingest authorization reads. The change removes only these unnecessary catalog reads when all recorded resource lists are empty. Original-page validation, chunk reads, frozen payloads and ACK/cursor behavior are retained.

| Operation in the same fixture | Before | After |
|---|---:|---:|
| Resource-catalog RPCs | 11 | 0 |
| Provenance checks / archive manifest reads | 11 / 11 | 11 / 11 |
| Chunk reads / validated chunk bytes | 12 / 392,849 | 12 / 392,849 |
| Fake profile lookups / ingests | 1 / 1 | 1 / 1 |

Both variants assert the exact canonical source prefix, contiguous frame offsets, eight frames, and a pending queue whose acknowledged position has not advanced past the remaining text. The after fixture and final archive-access regressions pass; nearby canonical-history, retry, source-provenance and replay regressions also pass.

These are operation counts, not production latency or indexing measurements. Do not enable memory capture, ingest existing conversations, reduce selected sources, skip authorization, or change retry deadlines merely to obtain timing samples. Further live conclusions require a representative authenticated request and known timing units.
