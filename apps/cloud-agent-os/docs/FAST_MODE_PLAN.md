# Provider Fast mode implementation plan

**Goal:** Make supported providers' actual Fast request tiers selectable and persistent in Cloud Agent OS.

**Spec:** `FAST_MODE_DESIGN.md`.

**Constraints:** Only this isolated feature worktree and branch. No paid inference, secrets, deployments, new permissions or main integration. Preserve bot, memory and authorization behavior. Public source and synthetic fixtures only.

## Throughput checkpoint

- Blocking first steps. Inspect latest main, upstream pin, provider docs and existing end-to-end state flow before code.
- Independent workstreams. Provider documentation and code-flow audits run in parallel. One implementation owner handles the coupled capability/adapter/UI patch.
- Shared mutable state. The implementation owner exclusively writes product/tests; the coordinator owns these design/verification documents and read-only validation processes.
- Smallest safe decomposition. One implementation task owns the common capability contract, native/subscription adapters and both composer entry points to avoid inconsistent paid-tier handling.

## Task 1. Capability, payload, selection and persistence

- [x] Add failing tests for server-derived support with unknown/custom endpoints and stale metadata, native serialized payloads with reasoning preserved, subscription routing, Home/bot/UI selection and persistence/resume.
- [x] Run the new tests and record expected failures before production edits.
- [x] Add the smallest trusted capability descriptor/helper and native request mapping; extend the existing immutable Fast snapshot path rather than add state.
- [x] Expose clear price/prerequisite/unsupported text and connect Home plus workspace/bot selection to existing request arguments.
- [x] Regenerate a final patch against the complete existing patch stack; never make generated build output the source of truth.
- [x] Run relevant backend/frontend suites and wrapper tests; record exact outcomes.

## Task 2. Whole change validation and publication

- [x] Review the complete diff independently for correctness, authorization, privacy, account/model constraints and pricing defaults.
- [x] Run types/build and Worker dry-runs using synthetic configuration; report lint/CI baseline limits separately.
- [x] Review staged objects and intended feature history for sensitive data.

Publication follows these gates on the isolated feature branch. The branch commit and draft PR provide its receipt. Main integration and deployment require separate coordination with the parent.

## Review focus

Unknown legacy preferences remain off. Model/bot switches cannot revive a prior paid choice. Custom endpoints do not inherit official-provider capabilities by display name. Account/provider revalidation wins over saved support metadata. Errors never trigger an implicit paid retry or silently change the user's selected tier.
