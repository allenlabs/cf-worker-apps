# Operational verification

This public document describes checks to repeat for a deployment. Deployment domains, account resource IDs, machine paths, measured results and source inventories belong in a private operations record. This document does not claim that a particular deployment has passed these checks.

1. Run `npm run test:observe`, `npm run check:observe` and the Receiver/Tail Wrangler dry runs. Record the source revision and actual results in the private deployment record.
2. Confirm the Receiver, Tail collector, durable journal, archive bucket and producer bindings against the private deployment configuration. Exclude collectors from their own source list.
3. Send an authorized synthetic event. Confirm durable acceptance, idempotent retry behavior, authenticated query/Live delivery, and eventual archive persistence. Report measured latency as an observation, not an SLA.
4. Check source health and hourly archive references. Verify pending batches, retries, missing references and index consistency. Do not remove segments independently of their indexes.
5. Verify unauthenticated requests are rejected and browser sessions use secure cookies. Store screenshots or exported observations containing deployment data privately.

Tail delivery is best effort. Full SDK spans, metrics and long-running progress require the appropriate explicit producer integration. Filtering does not establish that arbitrary payloads contain no personal data. Retention and compaction must account for both segments and indexes.

See [operations](OPERATIONS.md), [collector contracts](../collectors/README.md), and Cloudflare's [Tail request redaction rules](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/).
