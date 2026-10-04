# Repository integration verification

Historical record of the initial ZIP import. The source and dashboard were
subsequently developed further; current behavior and validation are in
[operational verification](OPERATIONAL_VERIFICATION.md).

Date: 2026-09-08. Imported from `cf-observe-v0.1.0.zip` into
`allenlabs/cf-worker-apps`, workspace `@cf-worker-apps/cf-observe`.

## Changes

- Original `src/` and original dashboard assets are byte-for-byte preserved.
- The repository's web-worker TOML template was adapted for the existing static
  dashboard at `workers/web/wrangler.toml`; no Vite/SSR build is needed. Top-level
  assets routing, SQLite DO migration, R2 binding, and 10-second batching remain.
- Compatibility date is `2026-08-15`, supported by both pinned test/deploy runtimes.
- Development secrets and their example live beside the Wrangler config. Secret
  commands explicitly select that config. Generated secrets remain gitignored.
- Original tests now use Vitest's Node project; four additional tests execute in
  workerd with local Durable Object SQLite and R2 bindings.
- Root workspace scripts and the root npm lockfile include the app. All existing
  dependency records/versions were preserved. npm also restored missing workspace
  registrations and optional platform package records, including Windows natives.
- No GitHub Actions were added, per repository convention.

## Executed checks

Environment: Windows, Node 24.19.0, npm 11.11.0, Vitest 4.1.7,
`@cloudflare/vitest-pool-workers` 0.22.0, Wrangler 4.129.0.

| Check | Result |
|---|---|
| `npm ci --workspace @cf-worker-apps/cf-observe` | Clean locked workspace install succeeded |
| `npm run test:observe` | 59 tests passed: 55 Node, 4 workerd |
| `npm run -w @cf-worker-apps/cf-observe test:coverage` | Imported baseline thresholds pass |
| `npm run check:observe` | 29 JavaScript modules parse |
| `npm run dry-run:observe` | Bundle and 4 static assets load; DO/R2/assets bindings recognized |
| `npm run dev:observe -- --local --ip 127.0.0.1 --port 8797` | Local Wrangler/workerd starts using the moved config and local secrets |
| Included `scripts/smoke.mjs` against local workerd | Auth separation, durable ingestion, explicit idempotency, immediate query, raw detail, then R2 archive query pass |
| HTTP static assets | `/`, `/app.js`, `/style.css`, `/favicon.svg` return 200 with correct content types |
| Independent integration review | No critical/important integration findings |

The four workerd tests exercise object eviction/reconstruction before archival,
alarm-driven compressed R2 persistence, stable event identity and idempotency,
hibernated WebSocket attachments and delivery, session cookies/origin checks,
and OTLP JSON plus gzip-compressed protobuf wire preservation. These test bodies
use real local platform bindings rather than the original Node adapters.

Node-only source coverage: statements 76.19%, branches 69.57%, functions 87.17%,
lines 75.44%. Those measured imported-source baselines are enforced in
`vitest.config.ts`; no existing app's coverage threshold was changed. The report
does not include workerd or browser coverage and does not claim 100% coverage.

The local smoke completed ingestion through immediate raw inspection in 148 ms
on this run, then verified the same record in R2 after the configured flush.
This is one localhost synthetic observation, not event-to-screen latency or an SLA.

## Limits

Cloudflare deployment and synthetic checks were subsequently completed on the
same date; see [deployment verification](PRODUCTION_VERIFICATION.md). Production throughput,
event-to-screen latency, billing, and real SDK/Collector conformance remain
unmeasured. The deployed browser login screen was checked; the authenticated
dashboard rendering was not exercised in the browser. Screenshots containing deployment details are retained only in private operations records.

Other apps' full tests/builds were not rerun: their source, package manifests,
and existing locked dependency versions were unchanged. The monorepo's
`npm audit --omit=dev --workspace ...` still reports inherited PostCSS/nanoid
advisories; it includes shared dependencies from other workspaces, so it is not a
clean app-isolated audit. CF Observe's deployed source has no external runtime
dependencies. No unrelated dependency upgrades were made.

Pipelines/Iceberg/R2 SQL, full-text indexes, managed retention, PromQL, alerting,
and fine-grained multi-user authorization are outside this imported version.
