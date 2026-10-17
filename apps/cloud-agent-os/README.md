# Cloud Agent OS deployment wrapper

Deploy a pinned [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) with Cloudflare Access
or OpenID Connect sign-in (Ed25519 issuer with PKCE S256), plus an existing Cloud Agent inference
service. This package follows the official
[Starter](https://github.com/cloudflare/cloudflare-os-starter)'s private-Worker deployment pattern.
It does not copy upstream history or replace an existing Cloud Agent installation.

The upstream SHA lives in `upstream.json`. All reusable adapters, reviewed patches, tests and build
instructions live here. Customer identities, domains, resource IDs and runtime account selection
belong in a private deployment repository. OAuth grants and client secrets belong only in the
secret manager and Worker secret bindings.

## Boundaries

| Worker | Public route | State or dependency |
| --- | --- | --- |
| Router | One custom domain | Static frontend; internal Workshop and Gatekeeper service bindings |
| Workshop | None | Upstream DO migrations, two KV namespaces, one R2 bucket, Worker Loader and Browser bindings |
| OIDC Gatekeeper, OIDC mode only | Through router only | New login state; its own client secret and issuer/subject allowlist |
| Context Gatekeeper | Through router only | Upstream DO migrations and a separate KV namespace |
| MCP Gatekeeper, optional | Through router only | Upstream MCP account DOs; separate user-authorized connector grants |

Every Worker has `workers_dev` and preview URLs disabled. The router owns the only custom domain.
OIDC is the default when `auth.mode` is omitted, or set it explicitly to `"oidc"`.
Its Workshop frontend is built with `VITE_CF_ACCESS_MODE=false`; the backend sets
`AUTH_GATEKEEPERS=oidc` and `DISABLE_PASSWORD_AUTH=true`. Password sign-up/login remain disabled
while the OIDC vendor is configured. The OIDC Gatekeeper verifies identity before the Workshop
creates its email-keyed account. Admin and model-user lists must be subsets of the pinned login
allowlist. Login authorization does not grant access to business data.

Set `auth.mode` to `"access"` for upstream's native Cloudflare Access authentication. Copy
`deployment.access.example.json` and set the Access team origin in `auth.issuer`, the application's
AUD tag in `auth.audience`, and 1–100 unique lowercase emails in `auth.allowedEmails`. The wrapper
sets `CF_ACCESS_ISS`, `CF_ACCESS_AUD` and `VITE_CF_ACCESS_MODE=true`, and omits the OIDC Worker,
bindings, checks and secret requirement. Omit `workers.oidc`. The native backend verifies Access
JWTs and refuses password login/signup. `allowedEmails` validates administrator and model-user
subsets; it does not install or enforce an Access policy. Configure permitted identities in
Cloudflare Access separately. The model bridge remains required in both modes.

The model binding is `CODEX_BRIDGE`, targeting the existing runtime's `CloudAgentInference`
entrypoint. The runtime retains its own encrypted account grants. Read the [inference protocol and tests](../cloud-agent/docs/INFERENCE_BRIDGE.md) for limits and cancellation behavior. It must separately set
`INFERENCE_BRIDGE_MODEL`, `INFERENCE_BRIDGE_ACCOUNT_ID` and `INFERENCE_BRIDGE_ALLOWED_USER_IDS`.
The Workshop uses the same model and allowed user IDs in `CODEX_BRIDGE_MODEL` and
`CODEX_BRIDGE_ALLOWED_USER_IDS`. Its frontend receives the same fixed model in
`VITE_CODEX_BRIDGE_MODEL`: Add Model shows a single Codex subscription and no API credential,
endpoint or header fields. The submitted config contains an empty token. Without that build flag,
the upstream direct-provider form and its normal API-token validation remain unchanged.
A successful OS login alone must not select or authorize an
arbitrary subscription account.

`modelBridge.model` must use 1–128 ASCII letters, digits, dots, underscores or hyphens;
model availability is checked against the runtime catalogs. `modelBridge.allowedUserIds`
must contain 1–20 pinned lowercase email identities, each at most 254 characters.
These bridge limits do not reduce the separate login or administrator identity limits.

Set `modelBridge.management` to `"admin"` to manage that existing connection centrally.
Admin's **Providers** tab shows the configured Codex subscription and lets an administrator
enable or disable its fixed model. The model is then available to permitted users without
creating a per-user provider record. Users choose their default and quick models on **Models**,
and can select a model for each chat. Personal provider creation and edits are refused by the
server in this mode; existing records and preferences are retained rather than deleted.
Disabling the subscription prevents new calls through previously issued model bindings too.
No provider credential or account selection is stored in admin configuration: the deployment's
service binding and the existing runtime's account/model/actor policy remain authoritative.
Omitting `management`, or setting it to `"user"`, preserves the original per-user setup flow.
This subscription catalog does not require or emulate a Cloudflare AI Gateway.

For optional SIWC subscription setup in Access mode, set `modelBridge.setup` to `"siwc"` and
point `modelBridge.service` at a separately deployed SIWC subscription Worker. That Worker must
provide the `CloudAgentInference` entrypoint and handle login and API requests beneath
`/gatekeeper/subscription`. The router adds `GATEKEEPER_SUBSCRIPTION` for this service through its
existing `/gatekeeper/*` routing. It adds no Workshop Gatekeeper vendor or authentication grant.
Protect this path with the same Cloudflare Access application as the router. The wrapper does
not deploy the subscription Worker or create its provider connection. Create a fresh provider
connection with provider `siwc` in that service; use its SIWC login flow, with no native Codex
device login or paid API fallback. OIDC mode rejects this setup option. Omitting `setup` preserves
the existing generated configuration.

## Native OpenCode agent loop

The Workshop runs its actual agent loop through `@opencode/sdk/workerd` 2.0.24. The existing
`ModelHandle` remains the inference transport, including subscription routing, streamed text and
reasoning, model metadata and usage. Pi message DTOs remain the compatibility format for model
history and canonical OS storage. The Workshop does not call the Pi agent loop.

Only existing OS tools are registered. Their validation, permissions, transaction guards, action
approval, connection requests and spawned-agent restrictions remain in the OS callbacks. Native
builtins and the SDK's synthesized CodeMode `execute` tool are disabled. Tool bodies wait for the
provider's complete successful stream and execute in emitted order. The next model request awaits
the existing OS step transaction; an approval stop ends at that committed boundary. Cancellation
during tools retains completed effects with their transcript and records prevented calls as errors.

Each pass persists its exact SQL prefix ownership before creating the SDK, uses a fresh prefix,
and restores only committed OS history. The native host closes before cleanup drops its recorded
tables. A subsequent pass can remove its recorded stale prefix after a restart, without touching
canonical OS tables. The prefix rewriter is vendored from Agents 0.28.1 under the MIT notice in
`overlay/packages/workshop-backend/src/OPENCODE_PREFIX_LICENSE`; upgrades need native SQL tests.

OS compaction and bounded retries remain outside the native loop; native compaction, title inference
and retries are disabled. One ten-minute cooperative abort signal covers the whole OS turn,
including compaction and retries, and each native pass allows at most 64 model requests. A callback
that ignores cancellation can outlive that signal. These limits are not a hard billing cap.
They do not close browser RPC sessions. Measure idle Durable Object duration separately:
[retained RPC targets extend their execution context](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/),
and [non-hibernateable idle time is billable](https://developers.cloudflare.com/durable-objects/platform/pricing/).

`build --check` exercises the real workerd adapter, canonical OS agent suites and Worker dry-runs.
Native adapter cases cover provider EOF, commit blocking, final failure, approval, cancellation,
unknown/malformed calls, disabled CodeMode, history restoration, scoped stale-prefix cleanup and
the model-step limit. Abrupt process-death recovery must also be checked when upgrading the SDK.

## Internal site-aware launch

Site launch requires OIDC. Access mode rejects `siteLaunch` because the native Access login does
not supply the verified issuer/subject principal required by launch tickets.

An authenticated host can embed `/launch` inside its existing site route. Set optional
`siteLaunch.parentOrigins` to the exact HTTPS host origins, for example
`{ "parentOrigins": ["https://portal.example.com"] }`. Keep the OS origin unchanged: its
OAuth callbacks and Context sharing domain continue to use the existing router origin.
Only the parent origin list reaches the frontend; the issuer and pinned subjects remain server-side.

Bind the host's server to the Workshop's `SiteLaunchGateway` Worker entrypoint. The host must
authenticate its own user, verify current site membership and administration policy, and issue a
short-lived context ticket through that private binding. There is no HTTP endpoint for issuing
tickets. The issuance payload is `{principal: {issuer, subject, email}, site: {id, environment,
displayName, timezone}, parentOrigin}`. The browser receives an opaque one-use handle to this
server-side context, not identity claims or a login token.
The OS redeems it only after its own OIDC login verifies the exact same principal.

The iframe bridge exchanges protocol version 1 messages using exact origins and the parent/iframe
window identity. `cloud-agent-os:host-init` starts the handshake, `cloud-agent-os:ready` lets the
host mint a fresh ticket, and `cloud-agent-os:site-launch` carries it in memory. Tickets never belong
in URLs or browser storage. Each owner receives a separate workspace for each environment/site;
returning to a site resumes that workspace and preserves existing standalone history. The trusted
site name, ID, environment and timezone become workspace context for ordinary and spawned agents.
Site workspaces omit automatic deployment-wide Context attachments and reject sharing/invites.
The launched iframe keeps its verified workspace selection in memory and prevents Home/history or
other workspace routes from replacing that site. Account-wide settings have an explicit return to
the site; standalone OS navigation is preserved. A document reload starts a fresh launch handshake.

This establishes site awareness and conversation separation. It does not grant an MCP connection,
authorize business data or prevent the owner from opening their other saved workspaces. Each data
service must still check current membership and tool grants. Existing OS sessions made before
verified subjects were stored continue to work, but the first internal site launch requires ordinary
OIDC sign-in again. Omitting `siteLaunch` keeps the launch feature disabled.

MCP is opt-in deployment configuration. It installs the upstream connector; it does not
automatically connect a server or grant tools. For a read-only pilot, authorize only the intended
server/scopes and bind specific read tools. Do not assume an MCP server's full catalog is read-only.
Keep `MCP_ALLOW_INSECURE=false`. Verify an innocuous metadata tool before patient or business data.
The wrapper pins MCP `BASE_URL` to `${origin}/gatekeeper/mcp`, so connection links and the OAuth
callback return through the public router. The client introduces itself as `Cloud Agent OS`.

For an endpoint that advertises both read and write OAuth scopes, set an explicit policy:

```json
"mcpScopes": {
  "https://mcp.example.com/team/mcp": ["openid", "profile", "email", "offline_access", "example.read"]
}
```

The patch passes this value as the SDK's explicit `scope` during authorization and code exchange,
and includes it in client registration metadata. Setting only client metadata would still let the
SDK choose all server-advertised scopes. Matching uses the complete canonical endpoint, including
its path and query. Other endpoints retain upstream discovery behavior. Invalid policy fails closed.
Changing this policy does not narrow an existing token: reconnect the account and verify the new
authorization request. Scope restriction and the named-tool grant are both needed; neither makes
an unrelated MCP endpoint read-only.

## Prepare and check

Use Node.js 24.19+ and pnpm compatible with the pinned upstream's `packageManager`. The
OpenCode SDK, plugin and AI packages are pinned to 2.0.24 for the native OS loop; the existing
model transport and storage message formats retain their pinned Pi DTO dependency.

```sh
npm test
node scripts/build.mjs --config /private/path/deployment.json --plan
node scripts/prepare.mjs --source /path/to/reviewed/cloudflare-os
node scripts/build.mjs --config /private/path/deployment.json --check
```

Copy `deployment.example.json` to private configuration and replace its synthetic values. Provision
the new KV namespaces and R2 bucket first, then supply their explicit references. The wrapper
refuses shared KV IDs and duplicate Worker names. It never infers existing resources or modifies
another installation's Worker configuration. This is a separate pilot, with separate DO namespaces.

`prepare` accepts an existing clean source checkout only when its HEAD equals the pinned commit.
Otherwise it fetches that exact commit into ignored `.upstream/`. It archives tracked upstream
files into a disposable `.build/<commit>-<overlay-hash>/cloudflare-os`, copies `overlay/` and the
`gatekeeper-oidc/` package, and applies `patches/*.patch` after `git apply --check`. The source
checkout remains unchanged. Do not edit generated build trees; change the reviewed overlay instead.

The build adds the overlay workspace importer to a disposable lockfile while reusing upstream's
locked dependencies. It runs upstream's uncached Context, frontend, router and backend builds,
and the MCP library/configurator builds when enabled. In OIDC mode, `--check` also drives the OIDC
Worker/DO flow under Miniflare. Access mode runs the upstream Access verification and frontend
authentication tests instead. Both modes run the MCP account OAuth regression suite when enabled
and test model configuration, admin-managed subscription authorization, restored-user identity, model preferences and the
selection-only UI alongside the existing Gateway behavior. Site launch checks cover one-use
identity-bound tickets, workspace ownership and agent context, iframe handshakes, scoped
navigation, reload and workspace recovery.
Generated Wrangler files preserve upstream build
rules and DO migrations, and are deleted when the build or deployment exits. `--check` packages
Workers with Wrangler `--dry-run`; it does not create cloud resources or verify a real login.

## Deploy and verify

For OIDC, register a dedicated confidential client with PKCE. Its callback is
`https://os.example.com/gatekeeper/oidc/oauth`. Export `OIDC_CLIENT_SECRET` from the secret manager
into an owner-only (`0600`) temporary JSON or env file. The deployment passes its path only to the
OIDC Worker's Wrangler `--secrets-file`, so the first Worker version and its required secret are
installed atomically. The wrapper never reads the secret contents. Supply Cloudflare deployment
authentication from the secret manager, not a tracked configuration file.

```sh
node scripts/build.mjs --config /private/path/deployment.json --deploy --oidc-secrets /private/path/oidc-secrets.json
```

OIDC deployment order is Context, OIDC, optional MCP, Workshop, then Router. The runtime inference
entrypoint must already exist. The wrapper deliberately does not deploy or reconfigure that runtime.
Remove the temporary secret export after deployment. Every OIDC deployment requires that secret
file; this avoids an interactive first-deployment prompt or a dummy Worker bootstrap.

For Access, first create a self-hosted Cloudflare Access application covering the router hostname
and all paths, including `/api` and its WebSocket connections. Set its Allow policy to the intended
identities and use an identity provider that supplies email claims. The wrapper neither provisions
the Access application nor changes its policies. Copy the application's team origin and AUD tag
into the Access deployment configuration. Supply Cloudflare deployment authentication as above.

```sh
node scripts/build.mjs --config /private/path/deployment.access.json --plan
node scripts/build.mjs --config /private/path/deployment.access.json --check
node scripts/build.mjs --config /private/path/deployment.access.json --deploy
```

Access deployment order is Context, optional MCP, Workshop, then Router. It needs no OIDC secret
export and rejects `--oidc-secrets`. Confirm the Access policy before exposing the router domain.

1. Confirm `/api` rejects an unauthenticated session. OIDC offers only the configured SSO; Access
   redirects an unauthenticated browser to its configured identity provider and rejects denied identities.
2. Sign in as an allowed identity, reload, and confirm `/admin` is restricted to configured admins.
3. In admin management mode, confirm the configured subscription in Admin's Providers tab and
   choose its model as a user; in user management mode, create a model profile first. Test one
   short model response.
4. Connect the permitted MCP endpoint and call a specifically granted harmless read tool.
5. Confirm every internal Worker has no public route and that browser/network output contains no credentials.

For per-user model setup, open Add Model and confirm the displayed Codex subscription. Its model config is
`{ "provider": "openai", "model": "<configured model>", "apiToken": "" }`.
The bridge enforces the model and user server-side; the frontend flag grants no permission and
adding a profile cannot broaden them.

These checks establish a pilot. They do not establish production multi-customer authorization,
automatic business writes, or migration of existing Cloud Agent conversations.

## Upgrades

Update one reviewed upstream SHA at a time. Reapply patches in a fresh build tree, run local tests
and a full dry-run, inspect upstream migration changes, and repeat native login/model/MCP checks
before adopting it. Never change existing Worker identities or storage references as part of an
upstream upgrade. The official Starter reference is documentation provenance, not a second source
pin: this wrapper builds only the commit in `upstream.json`.
