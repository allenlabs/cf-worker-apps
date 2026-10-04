# Verification report

This is the original ZIP author's historical report. Current repository checks
are recorded separately in [INTEGRATION_VERIFICATION.md](INTEGRATION_VERIFICATION.md).

**Package:** CF Observe v0.1.0  
**Date:** 2026-09-08  
**Status:** Source package with local automated evidence. Not a verified Cloudflare production deployment.

## Executed successfully

| Check | Result | Meaning |
|---|---|---|
| `npm test` | **55 passed; 0 failed** | Node test runner; real SQLite with emulated R2/DO bindings |
| `npm run check` | **28 JavaScript modules parsed** | `node --check` for src/public/scripts/tests/examples; not a type checker or Wrangler build |
| Offline Chromium fixture | **5 UI scenarios passed; 0 page errors** | Initial list, raw inspector, metric rendering, rapid search-change race, mobile layout |
| HTTP smoke against local demo | **Passed** | Auth, ingestion, explicit idempotency, immediate query, raw detail and later archive transition |
| Full raw export against local demo | **1 synthetic raw record exported** | Cursor-based export script and raw-detail route worked for the synthetic test |
| Cost calculator tests | **Passed** | Both R2 PUTs, unused allowances, upward billing-unit rounding, idle operation and invalid arguments |

Node version used: 22.16.0. The `node:sqlite` experimental warning on this version is expected. The test harness uses SQLite's actual synchronous transactions, not an in-memory JavaScript object pretending to be SQL. It **does** emulate Cloudflare scheduling, R2 operations, namespace routing and storage synchronization; those are not the production APIs executing in workerd.

The HTTP smoke's immediate-query timing was 17ms on its final local run. This is a localhost harness result and must not be cited as production latency or a one-second SLA.

## Important behavior covered

Raw JSON/protobuf preservation and 64-bit histogram counts; body validation; display-size bounds; durable pending state after object reconstruction; segment PUT and manifest PUT failure/retry; stable retry object key; idempotency before and after archival; rejected overload; UTC hour boundaries; no idle R2 writes; live filtering of full raw content before preview; no live success before durable sync; session expiry and read/write privilege separation; signed cursor tampering; full archive/pending pagination; buffer-to-R2 transition races; missing archive segment reported as an error; explicit continuation on broad/sparse queries; large service attributes cannot inflate every manifest without bound.

A browser regression reproduced an in-flight query hiding a subsequent tab search. The implementation now aborts superseded requests and ignores stale responses. The offline fixture test exercises that same interaction after the fix. Browser fixtures perform no external navigation/network calls and use synthetic API/WebSocket responses. They validate DOM behavior, not actual cookie/WebSocket behavior on a deployed origin. Screenshots are clearly marked LOCAL DEMO on desktop.

## Not executed / not verified

- **Target GitHub inspection, remote commit, PR, or merge:** no compatible GitHub connector was available; the target name/structure remains unverified.
- **Wrangler dry-run/build:** `npm run dry-run` was attempted and failed because `wrangler` was not installed. npm registry access was unavailable. No lockfile or dependency audit is represented as complete.
- **Actual workerd/Miniflare integration:** unavailable in this environment. Fetch-based class registration, hibernation, platform output gates, alarm behavior, static-assets binding and production bundling still require that test.
- **Cloudflare deployment or real R2 writes:** none. No account resources were created or modified.
- **Deployed-browser end-to-end test:** not run. Cookie/CSP/origin behavior has HTTP/unit coverage; the screenshot test uses offline fixtures.
- **External SDK/Collector conformance and load tests:** not run. Independent protobuf fixtures validate selected wire paths, not every possible SDK payload. OTLP error responses are currently JSON `{error}` plus HTTP status, not full google.rpc.Status protobuf error encoding.
- **Production throughput, long-history query performance and billing:** not measured. Default limits define bounded behavior, not guaranteed capacity. The calculator only estimates R2.
- **Independent code/security review:** not available. Automated checks and author self-review do not replace an independent review.

## Reproduce the checks

```bash
npm test
npm run check
npm run demo
```

In another terminal set the documented local demo environment variables and run `npm run smoke`. For optional offline browser fixtures, install Python Playwright and a Chromium binary in your own environment, then run:

```bash
CHROMIUM_PATH=/path/to/chromium python tests/browser_fixture.py
```

On Windows set `CHROMIUM_PATH` as an environment variable before running Python. This optional renderer is not a runtime dependency of the Worker. It writes synthetic screenshots into ignored `ui-evidence/` (or `UI_EVIDENCE_DIR`). It does not navigate to production URLs.

Before routing real traffic, follow DEPLOYMENT.md and REPO_HANDOFF.md. Record the actual Wrangler version, workerd tests, real SDK behavior and measured latency/cost in the repository's PR.
