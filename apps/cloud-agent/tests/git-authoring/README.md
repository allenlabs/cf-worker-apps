# Container-free personal skill authoring probe

This is a feasibility check, not a deployed feature. It runs a real Cloudflare
Agent and PiHarness over SQLite Durable Object storage in workerd. The language
model is a scripted faux provider; every outbound GitHub call is intercepted.
No GitHub credential, local Codex process, Git executable, Sandbox, or container
is used.

## Run

From a checkout with the Cloud Agent dependencies installed:

```sh
node apps/cloud-agent/tests/git-authoring/check.mjs
```

An isolated copy can reuse the same dependencies:

```sh
CLOUD_AGENT_REPO=/path/to/cf-worker-apps node /path/to/probe/check.mjs
```

No new dependency is required. The check uses the app's installed Miniflare 5,
Agents 0.26.0, Pi AI/Durable 1.0.2, and esbuild. The repository root also has a
different Miniflare version; the isolated command selects the app explicitly.

## What the check proves

Pi invokes bounded `draft_write`, `draft_read`, `draft_preview`, and
`draft_publish` tools. It writes a `SKILL.md` and reference in the same draft,
reads the reference, consumes the preview hash, and submits both files in one
mock `createCommitOnBranch` mutation. The DO supplies the repository, branch,
personal prefix, and expected base commit; the model supplies neither remote
address nor credentials.

The check restarts the native runtime and verifies draft persistence. It rejects
path traversal, absolute paths, scripts and oversized text. Separate fixture
drafts do not share files, and a bound fixture profile cannot be replaced. Two drafts sharing a stale base cannot replace one another's
commit in the compare-and-swap mock. Completed publication receipts replay
without another request, and receipt-ID reuse with changed inputs is denied.

The exact mutation payload and an `unknown` receipt are stored before network
I/O. A mock commit accepted before a lost response remains `unknown`; neither
the same receipt, a new publication ID, nor a runtime restart retries it. A
production reconciliation reader must inspect the remote branch and frozen
change set before permitting further publication. `clientMutationId` is only
correlation, not an idempotency promise.

The implementation also leaves malformed responses and possible commits
accompanied by GraphQL errors as `unknown`. The check exercises a generic
GraphQL rejection and a lost response; it does not inject every response shape.
An error is not assumed to prove that no remote side effect happened.

## Limits

The fixture HTTP routes are deliberately unauthenticated test controls. They
must never be deployed as application routes. Production must bind the verified
principal and organization before selecting the draft, constrain the repository
installation and allowed ref, and resolve the GitHub App/user credential in the
host. This check does not validate OAuth, a live GitHub mutation, branch rules,
signature requirements, or real model planning.

Only ASCII relative paths and bounded UTF-8 text additions are supported here:
32 files, 64 KiB per file, 256 KiB total. The probe does not clone a repository,
edit arbitrary binary files, delete files, create branches, merge conflicts,
run shell scripts, validate a complete plugin bundle, or install a skill.
Branch-base refresh and reconciliation are intentionally absent, so a rejected
or uncertain draft needs explicit review before a new draft is prepared.

GitHub GraphQL mutation field shapes are real, while the mock's conflict error
message is a fixture. No undocumented GitHub error type is used to classify
production stale-head errors. SDK beta API compatibility still needs validation
when changing dependency versions.
