# Cloud Agent

Cloudflare Agents and Pi keep one durable conversation per Channel Talk team-chat root. The companion [MCP Events worker](../mcp-events/README.md) receives signed App Hooks and forwards eligible messages. Replies return to the originating thread without a ChatGPT scheduled task. The documented Hook supports public, non-archived groups; see [private team-chat support](docs/PRIVATE_TEAM_CHAT.md) before changing the source boundary.

`PRODUCT_NAME`, authentication policy, Channel Talk routing and the management origin are supplied by deployment configuration. This public checkout contains example configuration only. Read [CLOUD_HANDOFF.md](docs/CLOUD_HANDOFF.md) before creating or updating an installation.

Read [the management workspace](docs/WORKSPACE_UI.md), [customer isolation](docs/TENANCY.md), and [Manager display names](docs/MANAGER_DIRECTORY.md) for the conversation UI and installation boundaries. Read [the architecture](docs/ARCHITECTURE.md) for the implemented runtime and [repository content storage](docs/REPOSITORY_CONTENT.md) for the proposed document-source integration. The [filesystem and plugin design](docs/FILESYSTEM_AND_PLUGINS.md) adds administrator uploads and per-root working files. The [common and organization Git plugin design](docs/COMMON_ORG_GIT_PLUGINS.md) describes scoped catalogs and automatic GitHub import. The [personal Git authoring design](docs/PERSONAL_GIT_AUTHORING.md) covers owner-scoped drafts and a container-free GitHub writer. The implemented [GitHub App connector](docs/GITHUB_CONNECTOR.md) adds private administrator drafts, Pi-assisted text authoring and an explicit reviewed atomic commit. Generic implementation, tests and design are published here before private installation tuning.

## Work in a cloud checkout

Use Node 24 or newer. From the repository root:

```sh
npm ci
npm run -w @cf-worker-apps/cloud-agent typecheck
npm run -w @cf-worker-apps/cloud-agent test
node apps/cloud-agent/skills/pstack/check.mjs --implementation-root apps/cloud-agent
```

`test` builds the Pi worker and the sibling MCP Events worker, then runs the real-workerd integration, OAuth, management and GitHub authoring checks with generated credentials and mocked outbound services. No production account or API token is required. `typecheck` checks JavaScript syntax and the Gateway declaration contract with the workspace's installed TypeScript compiler. It does not statically check the JavaScript implementation. Build files and local runtime state are ignored.

`test:coverage` also attempts native workerd profiling of the management module. If the runtime does not expose the Profiler API, it exits nonzero after the behavioral checks. It does not substitute Node harness coverage or claim application-wide coverage.

Read [the formal Channel Talk Command and API history](docs/CHANNEL_COMMAND.md) for the separate signed `/ai` WAM, explicit context sharing and current private-history limitations.

The [new thread setup](docs/NEW_THREAD_SETUP.md) lets staff choose a workflow, model and thinking level before explicitly creating a native team-chat root. Forms work without an inference account; account selection and first-use preferences happen only at actual AI admission.

The [customer workflow skill forms](docs/WORKFLOW_SKILLS.md) load versioned form definitions from normal skill resources. They support explicit patient/visit selection, editable reservation candidates, manual forms, reviewed exact-text delivery and durable reply receipts. The authorized [visit read contract](docs/VISIT_WORKFLOW.md) remains separate from general Ask/Pi context. Its legacy fixed draft API is retained only for active clients; see [deprecated interfaces](docs/DEPRECATED.md).

The reusable [Visit Gateway](docs/VISIT_GATEWAY.md) provides a Channel ingress helper and separate authenticated MCP reads. It keeps ingress/backend credentials and Channel/MCP identities separate while sharing the existing projected visit contract.

## Runtime and administration

- Each source root has its own Assistant Durable Object. Comments keep its account and Pi session. D1 persists the canonical Pi journal and transcript.
- Credentials Durable Objects encrypt OAuth credentials and verified account metadata. An account inventory selects a fixed account or explicit round-robin allocation for new roots.
- The SSO management page controls accounts, models, thinking levels, sessions and versioned text skills. Staff commands are limited to help, model and thinking, including Korean aliases. The signed App panel also offers scoped image generation; ordinary staff requests can ask the chat model to generate an image through the same durable executor. See [staff workflows](docs/STAFF_WORKFLOWS.md) for caller gates, private assets, recovery and provider diagnostics.
- Native Pi model-token totals are aggregated per account without counting replayed snapshots or cloned history twice. These are this server's measured tokens, not global subscription quota.
- A dedicated GitHubAuthoring Durable Object keeps each SSO administrator’s repository draft separate. Its private Pi transcript is persisted in D1. GitHub tokens are selected-repository Contents-only, and the model stages files without a publication tool.
- The [pstack hosted adapter](skills/pstack/README.md) is prepared and locally verified. It has not been installed into the production skill catalog.

The supplied Wrangler configuration uses example domains, empty tenant settings and disabled replies. Supply private installation configuration and the `CONVERSATIONS` D1 binding before deploying. Use the handoff's storage and secret constraints when updating an existing installation. No secret values, login callbacks, session cookies or real conversations are included in this directory.
