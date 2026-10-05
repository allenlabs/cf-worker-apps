# Cloud continuation handoff

This repository contains generic Cloudflare Agents/Pi code. Organization-specific origins, identifiers, role assignments, encryption context and operations notes belong in a separate private deployment repository. This upload does not deploy a Worker or install production skills.

## Start here

1. Use Node 24 or newer and run `npm ci` at the repository root.
2. Run `npm run -w @cf-worker-apps/cloud-agent typecheck` and `npm run -w @cf-worker-apps/cloud-agent test`.
3. Run `node apps/cloud-agent/skills/pstack/check.mjs --implementation-root apps/cloud-agent`.
4. Read the deployment's private handoff before modifying existing storage or authentication.

## Current work

The runtime supports one Assistant Durable Object per native team-chat root, durable replies, account pinning, SSO management, versioned text skills, verified identity metadata, model-token accounting and optional round robin for new roots. Existing comments keep the original account and session context.

The management workspace presents conversations as readable messages, with account, skill and Git settings in separate views. Verified provider account IDs supply account labels. D1 is required for native Pi journals and history; configure `CONVERSATIONS` and a fixed `TENANT_ID` before accessing an existing actor. Read [conversation storage](CONVERSATION_STORAGE.md), [customer isolation](TENANCY.md), and [the workspace](WORKSPACE_UI.md).

The pstack hosted adapter is prepared and locally verified but not installed into a production catalog. Its two payloads preserve upstream documentation and its MIT license. The adapter can guide text reasoning and review using skill activation/resource reads. Installing this text does not supply shell, Git, browser or child-agent tools. See `../skills/pstack/README.md`.

## Configuration and identity

Configure the management origin, SSO issuer/client and pinned administrators, allowed Channel Talk channel/group/app IDs, initial owner identity policy and encryption additional-data value through installation settings. The example config leaves installation-specific authorization empty and replies disabled. Use generated fixture identities for tests.

Preserve an existing installation's Worker identity, Durable Object namespaces, wrapping key, encryption context and OAuth registration during updates. Do not generate replacements just to redeploy code. Store secret values in an approved secret manager and Worker secret bindings. Never commit callback URLs, login codes, access or refresh tokens, browser cookies, deployment inventories or real message history to this public repository.

The Events worker forwards through the `PI_ASSISTANT` Durable Object binding. Set its target script to the privately configured Agent Worker, and preserve configured Events object/owner identities when migrating an existing installation. A new installation must configure its source boundary before enabling replies.

SSO administrator identity and model-provider account ownership are separate. Use the hosted OAuth connection flow to connect a model account. Do not substitute a local desktop credential. Missing verified metadata stays absent. The displayed usage is the model tokens captured by this service, not the user's global subscription quota.

## Runtime expansion

Cloudflare's experimental `@cloudflare/shell` offers a SQLite-backed Workspace and pure-JavaScript Git operations. It does not execute Bash. A Linux Sandbox attached to an Agent can run real commands, package installation, builds and tests. Keep account and runtime coordination in their existing Durable Objects and conversations in D1. Prototype these execution tools separately before changing the skill adapter's capability declaration. See `../skills/pstack/runtime-expansion.md` for primary sources.

## Verification and limits

The behavioral suites exercise actual workerd with generated credentials and mocked network services. They cover signatures, OAuth refresh, SSO/CSRF, account labels, filtering, ordered delivery, duplicate events, recovery, immutable account pins, session controls, skill manifests and usage accounting. They do not validate a real deployment or a newly connected provider account.

`test:coverage` attempts the runtime's native Profiler API. The available runtime reports `Profiler is not enabled`; behavioral tests can pass while coverage exits 2. No coverage percentage or reduced threshold is claimed. JavaScript syntax checks are not static type checking.

History pages and JSON downloads include up to 200 entries per request, with a native entry cursor for older pages and the root's latest 50 receipts. A default page contains 50 entries. The observed-root index has a 2,000-root ceiling, registration allows 20 accounts, the skill catalog allows 20 entries and the enabled manifest is bounded to 1 MiB. The pstack adapter uses two entries. No ChatGPT scheduled task is required for native team-chat replies.
