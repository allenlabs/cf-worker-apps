# CF Observe Implementation Plan

**Goal:** Deliver a runnable, repo-copyable Cloudflare telemetry explorer.
**Architecture:** Worker + temporary durable journal + R2 gzip segments/manifests + WebSocket UI.
**Tech Stack:** ESM JavaScript, Cloudflare Workers/DO/R2/Static Assets, Node built-in test runner.
**Spec:** ../specs/2026-09-08-cf-observe-design.md

## Execution checklist
- [x] Protocol: test OTLP normalization, 64-bit precision, histogram preservation and malformed bodies.
  Files: src/protocol.js, src/protobuf.js, tests/protocol.test.js.
- [x] Durability: test retry-stable jobs, manifest failures, restarts, backpressure and idempotency.
  Files: src/journal.js, src/segments.js, tests/journal.test.js, tests/helpers.js.
- [x] Query/security: test pagination, transition races, bounded scans, session forgery and origin checks.
  Files: src/query.js, src/auth.js, src/worker.js, tests/query.test.js, tests/http.test.js.
- [x] Dashboard: authenticated explorer, filters, live/reconnect, raw inspector and metrics/trace views.
  Files: public/index.html, public/app.js, public/style.css; browser exercise via offline synthetic API fixtures; local HTTP smoke tested separately.
- [x] Integration: Wrangler configuration, OTLP examples, local smoke harness, costs and handoff.
  Files: wrangler.jsonc, examples/, scripts/, docs/, README.md.
- [x] Verification: run node --test, syntax checks, browser checks; publish exact evidence and limitations.

Run tests before each corresponding implementation and after changes. No remote repository
mutation or cloud deployment is performed without an available authenticated tool. All
runtime emulation is explicitly identified as emulation, not a Cloudflare production test.

## Unperformed deployment gates
- [ ] Install Wrangler and validate with real workerd/Miniflare.
- [ ] Inspect and integrate with the actual target repository.
- [ ] Authorized staging deployment, real SDK/browser checks, throughput and billing measurement.

See ../../VERIFICATION.md for the exact local evidence and runtime limits.
