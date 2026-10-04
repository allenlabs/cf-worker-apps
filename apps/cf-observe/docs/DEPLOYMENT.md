# Deployment and repository integration

The 2026-09-08 deployment and synthetic check results are recorded in
[production verification](PRODUCTION_VERIFICATION.md).

## Prerequisites
Node >=22.13, npm, a Cloudflare account with Workers Paid and R2 enabled. This app is integrated into `allenlabs/cf-worker-apps` as `@cf-worker-apps/cf-observe`. Repository integration does not deploy Cloudflare resources.

1. Run `npm ci` at the repository root using its committed lockfile.
2. Change directory to `apps/cf-observe`. Do not commit `.dev.vars`, `.wrangler`, `node_modules` or test outputs.
3. Set `name`, `[[r2_buckets]].bucket_name` and `DATASET` in `workers/web/wrangler.toml`. Preserve the SQLite migration and class export. Choose a new private bucket, not a bucket containing unrelated data.
4. Runtime dependencies are empty; the workspace pins Wrangler and Vitest development dependencies.
5. Run `npm test`, `npm run test:coverage`, `npm run check` and `npm run dry-run`. Tests include a Node project and a workerd project with local Cloudflare bindings.
6. Authenticate with `npx wrangler login`, create the configured bucket and `npm run deploy`.
7. Configure separate high-entropy secrets with `npm run secret:ingest` and `npm run secret:viewer`. These scripts select `workers/web/wrangler.toml`. The app refuses missing, short, identical or example-placeholder secrets.
8. Open the deployment URL and enter VIEWER_TOKEN. Keep R2 private. Optionally add Cloudflare Access/WAF protection; do not inadvertently block the SDK's Bearer-authenticated ingestion routes.
9. Run the smoke test below on a staging deployment before routing real telemetry.

The initial deployment may briefly expose the empty static login page. Authenticated APIs fail closed until secrets exist. Avoid placing real secrets in command history, build variables committed to git, URLs, fixture files or screenshots.

## Smoke test
POSIX shell:

```bash
export OBSERVE_URL='https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'
read -rs -p 'Ingestion token: ' INGEST_TOKEN; export INGEST_TOKEN; echo
read -rs -p 'Viewer token: ' VIEWER_TOKEN; export VIEWER_TOKEN; echo
npm run smoke
unset INGEST_TOKEN VIEWER_TOKEN
```

PowerShell 7:

```powershell
$env:OBSERVE_URL = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'
$env:INGEST_TOKEN = Read-Host 'Ingestion token' -MaskInput
$env:VIEWER_TOKEN = Read-Host 'Viewer token' -MaskInput
npm run smoke
Remove-Item Env:INGEST_TOKEN, Env:VIEWER_TOKEN
```

The script writes one synthetic record (with a duplicate retry using the same Idempotency-Key), then checks authorization boundaries, immediate query, raw detail and R2 persistence. It leaves the synthetic record in the archive. A 90-second smoke deadline is a test timeout, not a storage SLA. A failed deadline requires inspecting health; it is not proof the event was lost.

## Local development
`npm run init:secrets` generates local-only `workers/web/.dev.vars` beside the Wrangler config without overwriting an existing file. `npm run dev` runs Wrangler. `npm run demo` instead runs the explicit fake-R2 demo and requires no npm dependencies. Never run the demo server on a public host.

## Monitoring and changes
`GET /api/health` requires VIEWER_TOKEN or session. Watch `pendingBytes`, `pendingBatches`, `oldestPendingAt`, `failureCount`, `lastError` and `lastArchivedAt`. Also inspect Cloudflare's own request, CPU, DO wall-time, SQLite rows and R2 operation meters. This version has no alerting engine or automatic bill cap.

Do not rename/reset the writer DO namespace, class, DATASET or bucket of a populated deployment without a migration. A new writer sequence starting from zero against old manifests is unsafe. Do not create multiple independent writers for the same dataset prefix. Make staging a separate Worker/DO namespace and R2 bucket.

Archive data has no automatic TTL in this version. Do not enable a lifecycle deletion rule for only segments or only indexes. Read RELIABILITY.md before implementing retention or compaction.

## Primary documentation
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/wrangler/commands/
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- https://developers.cloudflare.com/r2/buckets/create-buckets/
