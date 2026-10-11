# Subscription Inference Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a server require retained SIWC grants for all ordinary subscription inference while preserving existing snapshots and independent image/bridge behavior.

**Architecture:** Validate a server environment enum before credential reads. Credentials exposes truthful selected inference status and independent grant readiness; existing model/admission consumers follow status. Stored request snapshots remain immutable.

**Tech Stack:** Existing JavaScript Workers, Durable Objects, Pi 1.0.2 and native workerd fixtures; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-subscription-inference-selection.md`

## Global Constraints

- Policy: `SUBSCRIPTION_INFERENCE_PROVIDER`, enum `auto|siwc`, default `auto`; private installation explicitly `siwc`.
- SIWC readiness requires the existing credential and both `resource.invoke` and `chatgpt.tokens.use.direct`.
- Preserve provider/account/model/session snapshots, image grants, independent bridge policy, identities, stores and OAuth/encryption parameters.
- No automatic fallback/replay, new grant, dependencies or schema changes.
- Public-first publication; generated fixtures only. Repository instructions require main and immediate push after each commit; root owns publication, adoption and deployment.

## Review Focus

- SIWC mode applies to all ordinary subscription accounts; missing SIWC never falls back to native.
- Malformed policy and either missing SIWC scope fail before provider fetch.
- Ordinary SIWC selection does not disable an explicitly native bridge or images.
- Refresh/identity/expiry describe the selected grant, including an account whose other grant remains connected.
- Previously completed operations replay without calls; unfinished native operations are blocked before native access/fetch instead of rewriting snapshots.

## Task 1: Runtime policy, status and native regressions

**Files:**
- Create a small policy helper under `apps/cloud-agent/workers/pi/` if needed.
- Modify `apps/cloud-agent/workers/pi/index.js`, `subscription-models.js`, `github-authoring.js`, `inference-entrypoint.js`, `admin-view.js` and example configuration/documentation as needed.
- Extend genuine runtime fixtures in `apps/cloud-agent/tests/workers/codex-images-native-check.mjs` and affected bridge/admin/GitHub fixtures where the contract requires.

**Interfaces:**
- Input: server environment enum and existing Credentials actor.
- Output: selected status consistent with ordinary consumers; independent native/SIWC readiness usable by the bridge.

- [x] Add failing native fixtures for the exact policy and acceptance cases in the spec; capture RED.
- [x] Implement the smallest policy/status/refresh/bridge/UI change. Keep prior snapshot code unless a test identifies a necessary fix.
- [x] Run targeted genuine workerd and actual SDK fixture checks; capture GREEN and prove no real upstream calls.
- [x] Run required Cloud Agent behavior/typechecks and coverage. Report disabled Profiler separately.
- [x] Review the complete generic diff for correctness, scope and private data, then root commits and immediately pushes main.

### Generic verification — 2026-10-11

The complete Cloud Agent build/behavior suite and final syntax/Gateway type contract pass. Genuine workerd fixtures verify both global SIWC accounts, both required scopes, selected identity/expiry/refresh, native guards before credentials/fetch, immutable completed/failed replay, independent bridge providers and native images. Focused policy, bridge and UI regressions were first observed failing and then passing. All provider endpoints are mocked; no real login, account entitlement or hosted release is claimed here.

The required `test:coverage` command passes its behavior and canonical SSO checks, then exits 2 because workerd reports `Profiler is not enabled`. Numeric coverage remains unmeasured; thresholds were not lowered. Independent review resolved unavailable-SIWC refresh/reconnect wording and found no outstanding correctness issues.

## Task 2: Private adoption and bounded acceptance

- [ ] Root transfers exactly the published generic files and records the public commit; verify byte equality.
- [ ] Configure SIWC-only ordinary inference for the installation, retain the SIWC bridge setting, and preserve deployment resources. Missing grants remain unavailable.
- [ ] Build and locally verify the candidate using genuine runtime fixtures; root reviews exact hosted candidate/resources before release.
- [ ] Release only the intended existing Worker after all checks, then run one synthetic ordinary inference acceptance without posting a team-chat message. Record actual provider/model observation separately from requested metadata.
- [ ] Remove owned temporary clients, verify production preservation, update private handoff and immediately push any private commit.
- [ ] State the verified successful route and remaining native refusal uncertainty.
