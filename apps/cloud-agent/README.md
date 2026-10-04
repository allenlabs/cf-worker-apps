# Cloud Agent

Cloudflare Agents and Pi keep one durable conversation per Channel Talk team-chat root. The companion [MCP Events worker](../mcp-events/README.md) receives signed App Hooks and forwards eligible messages. Replies return to the originating thread without a ChatGPT scheduled task.

`PRODUCT_NAME`, authentication policy, Channel Talk routing and the management origin are supplied by deployment configuration. This public checkout contains example configuration only. Read [CLOUD_HANDOFF.md](docs/CLOUD_HANDOFF.md) before creating or updating an installation.

## Work in a cloud checkout

Use Node 24 or newer. From the repository root:

```sh
npm ci
npm run -w @cf-worker-apps/cloud-agent typecheck
npm run -w @cf-worker-apps/cloud-agent test
node apps/cloud-agent/skills/pstack/check.mjs --implementation-root apps/cloud-agent
```

`test` builds the Pi worker and the sibling MCP Events worker, then runs the real-workerd integration, OAuth and management checks with generated credentials and mocked outbound services. No production account or API token is required. `typecheck` checks JavaScript syntax; it is not static type checking. Build files and local runtime state are ignored.

`test:coverage` also attempts native workerd profiling of the management module. If the runtime does not expose the Profiler API, it exits nonzero after the behavioral checks. It does not substitute Node harness coverage or claim application-wide coverage.

## Runtime and administration

- Each source root has its own Assistant Durable Object. Comments keep its account, Pi sessions and transcript.
- Credentials Durable Objects encrypt OAuth credentials and verified account metadata. An account inventory selects a fixed account or explicit round-robin allocation for new roots.
- The SSO management page controls accounts, models, thinking levels, sessions and versioned text skills. Staff commands are limited to help, model and thinking, including Korean aliases.
- Native Pi model-token totals are aggregated per account without counting replayed snapshots or cloned history twice. These are this server's measured tokens, not global subscription quota.
- The [pstack hosted adapter](skills/pstack/README.md) is prepared and locally verified. It has not been installed into the production skill catalog.

The supplied Wrangler configuration uses example domains, empty tenant settings and disabled replies. Supply private installation configuration before deploying. Use the handoff's storage and secret constraints when updating an existing installation. No secret values, login callbacks, session cookies or real conversations are included in this directory.
