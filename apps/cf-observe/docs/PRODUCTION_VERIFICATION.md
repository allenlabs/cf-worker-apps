# Deployment verification

Keep each deployment's origin, resource identifiers, release IDs, source revision, observations and screenshots in a private operations record. This public file is a checklist and contains no production result claim.

1. Create the required resources using private deployment configuration. Install distinct ingestion and viewer credentials as Workers Secrets.
2. Run the deployment's synthetic smoke check with `OBSERVE_URL`, `INGEST_TOKEN` and `VIEWER_TOKEN` supplied through the local environment. The smoke check leaves a synthetic record in that deployment.
3. Confirm unauthenticated access is denied, ingestion is durable and repeated idempotency keys retain one record. Check immediate query results and repeat after archive flush.
4. Verify the web assets, secure cookie session, authenticated WebSocket and a live synthetic event through their real endpoints.
5. Record unsupported or unmeasured behavior alongside results. A single successful smoke check does not establish sustained-load performance, outage recovery, cost or a latency SLA.

Do not place credentials in URLs, issues or committed configuration. Review [operational verification](OPERATIONAL_VERIFICATION.md) for source collection and archive checks.

Resource setup references are the official [R2 bucket CLI documentation](https://developers.cloudflare.com/r2/buckets/create-buckets/) and [Workers Secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).
