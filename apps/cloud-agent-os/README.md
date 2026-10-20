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
| Sign-in Gatekeeper, OIDC or OAuth JWT mode | Through router only | Single-use login state; pinned issuer/subject/email allowlist |
| Context Gatekeeper | Through router only | Upstream DO migrations and a separate KV namespace |
| MCP Gatekeeper, optional | Through router only | Upstream MCP account DOs; separate user-authorized connector grants |

Every Worker has `workers_dev` and preview URLs disabled. The router owns the only custom domain.
OIDC is the default when `auth.mode` is omitted, or set it explicitly to `"oidc"`.
Its Workshop frontend is built with `VITE_CF_ACCESS_MODE=false`; the backend sets
`AUTH_GATEKEEPERS=oidc` and `DISABLE_PASSWORD_AUTH=true`. Password sign-up/login remain disabled
while the OIDC vendor is configured. The OIDC Gatekeeper verifies identity before the Workshop
creates its email-keyed account. Admin and model-user lists must be subsets of the pinned login
allowlist. Login authorization does not grant access to business data.

The Workshop releases a login token once, after the popup confirms its matching ticket and nonce.
It then retains only the ticket hash until the original two-minute delivery expiry. A popup whose
confirmation reply was lost can repeat that confirmation after the login tab receives its token;
the retry never releases another token or extends the expiry. Wrong tickets, wrong nonces and
expired attempts remain denied. The existing alarm clears the proof and preserves any account link.
If session creation fails, the callback throws rather than returning a successful handoff page,
while the login tab can still receive the recorded failure reason.

When password login is disabled and OIDC is the only configured sign-in vendor, native protected
top-level pages automatically enter the existing provider in the same browser tab. The tab stores a bounded
nonce, independent receive secret and validated return path in sessionStorage before navigating.
The handoff confirms the existing ticket and nonce, then requires the separate receive proof to
restore the capability and receive the OS session once. PendingLogin stores only the proof hash;
the existing 30-minute pending and two-minute delivered limits still apply. Inline sign-in, embedded launch, other sign-in choices
and connected-account flows retain their popup behavior.

Protected same-origin documents can enter through `/?sign_in=oidc&return_to=<encoded-relative-path>`.
An existing valid OS session returns directly after server verification. Return paths are limited
to normalized native routes and the exact subscription document with its recognized connection/add
fragment; external URLs, callback/API paths, controls and ambiguous paths are refused. Browser Back,
cancellation and errors require a manual retry. Invalid stored OS sessions recover automatically
once; a newly received native session rejected again requires a click. Permission denials do not
trigger another login. A non-secret received marker remains until the destination authority accepts
the session; native identity verification cannot clear a subscription rejection. Explicit logout
stays signed out until the user chooses sign-in again. No browser session cookie or alternate OAuth implementation is added.

Use `auth.mode: "oauth-jwt"` only for a provider with the signed access-token contract below.
Copy `deployment.oauth-jwt.example.json`, then set the exact HTTPS resource origin, explicit scopes
and `tokenEndpointAuthMethod` to `"none"` for a public PKCE client or `"client_secret_post"` for a
confidential client. The existing `workers.oidc` binding and `/gatekeeper/oidc/oauth` callback serve
both profiles. Omitted mode and `"oidc"` keep the existing OIDC flow.

OAuth JWT discovers [RFC 8414 metadata](https://www.rfc-editor.org/rfc/rfc8414) at
`/.well-known/oauth-authorization-server`, inserting that path before any issuer path. It requires
authorization code, S256 PKCE, an advertised configured token authentication method and
[callback issuer identification](https://www.rfc-editor.org/rfc/rfc9207). The callback must contain
exactly the pinned `iss`. Authorization and code exchange send the same configured
[resource indicator](https://www.rfc-editor.org/rfc/rfc8707). Endpoints and JWKS must share the issuer origin.

For an OAuth JWT provider Worker in the same Cloudflare account, optionally set
`auth.providerService` to its Worker name. The private sign-in Worker then uses an
`IDENTITY_PROVIDER` HTTP service binding for metadata, code exchange and JWKS requests, retaining
their canonical HTTPS URLs, response limits and validation. Browser authorization still uses the
provider's public URL. The binding does not route arbitrary incoming requests and never falls back
to public HTTP after a binding failure. Omit it to retain public HTTP requests. OIDC and Access
configuration reject this option.

The bearer access token must use RS256 with one matching public RSA verification key, at least
2048 bits. It must contain the exact issuer, a single string `aud` equal to `auth.resource`, a pinned
`sub`, nonempty `jti`, integer `iat` and `exp`, `client_id` and `azp` equal to the configured client,
`token_use: "access"`, a space-separated `scope` containing every configured scope, a string
`email`, `emailVerified: true` and `banned: false`. The exact issuer/subject/email allowlist still
authorizes login. `iat` may be at most five minutes old or 60 seconds ahead; `exp` must follow `iat`
and must not have elapsed. Alternate algorithms, ambiguous keys and audience arrays are rejected.
This profile rejects the `openid` scope and does not read an ID token or userinfo or send a nonce.
Explicitly include `offline_access` in `auth.scopes` when the identity provider requires it to issue
refresh grants. Sign-in discards provider access, ID and refresh tokens after verifying identity;
it never persists them, displays them, sends them to the model bridge or refreshes a grant.
Provider expiry bounds the handoff identity. The preexisting Workshop session lifetime is
independent of provider-token expiry.

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
`VITE_CODEX_BRIDGE_MODEL`. In legacy user-managed mode, Add Model shows only the fixed
subscription, with no API credential, endpoint or header fields. In admin-managed mode,
organization subscription requests and personal API provider requests use separate transports.
The personal provider form retains its API-token, endpoint and header validation.
A successful OS login alone must not select or authorize an
arbitrary subscription account.

`modelBridge.model` must use 1–128 ASCII letters, digits, dots, underscores or hyphens;
model availability is checked against the runtime catalogs. `modelBridge.allowedUserIds`
must contain 1–20 pinned lowercase email identities, each at most 254 characters.
These bridge limits do not reduce the separate login or administrator identity limits.

Set `modelBridge.management` to `"admin"` to manage named subscription connections centrally.
Admin's **Providers** tab manages the organization subscription and whether users may add
personal providers. When SIWC setup is configured, this tab includes native subscription
management using the existing protected setup endpoints. Administrators also get a connection button in the initial
model setup step, before Admin is accessible. The shared model is available to permitted users without a personal
provider record. Users manage their own API providers, default model and quick model in
**Providers**, and can select a model for each chat. Personal credentials stay in that user's
storage. Disabling personal providers hides their models without deleting their records.
Disabling the shared subscription prevents its new requests, including calls through tagged
model bindings, while independently authenticated personal providers remain usable.
Shared configs carry a server-owned subscription transport tag; personal CRUD rejects that tag.
Older untagged shared model bindings must be reconnected and do not fall back to a paid API.
Each connection appears as its own model choice, with independent availability, default and
quick-model selection. The owner keeps its existing physical-model profile ID. Added objects use
`subscription-account-<UUID>` profile IDs, while inference still uses the configured physical model.
Admin's Providers card shows each connection's name and readiness with its own availability toggle.
The native subscription panel compares saved quota windows, reset times, credits, and lookup status.
Administrators add, rename, connect, and delete named subscriptions inside the OS. Deletion requires
confirmation, disconnects the saved connection, and removes its model choice. The owner connection
and connections referenced by Channel Talk conversations or account selection are protected. Deleting
a connection does not cancel its provider subscription. The standalone protected setup
page remains available for recovery. Unconnected objects remain visible;
inference requires that object's own connected grant and never falls back to another connection.

Connection names, provider names, and model display names are separate from routing IDs. Organization
administrators manage shared provider and model names. Users name their own custom providers in
**Providers** while retaining the existing model display-name field. Renaming preserves credentials,
model selection IDs, and physical provider/model routing. Existing chat messages retain their saved
author names; subsequent model choices and turns use the current names.

New chats start with **Choose provider**, then **Choose model**. The model menu lists only the
selected connection's models; changing providers clears the model choice and keeps the draft.
Saved defaults do not select a provider or model automatically. Send and Enter require a model
choice, or an explicit **No agent** choice. Connections retain separate identities even when their
names and physical models match. Existing chats keep their current model, including hidden models.
The picker shows loading and retryable discovery failures separately from an empty catalog. Workspace
models become available independently of chat history. Each subscription lists its configured physical
default once under the actual model name, with a star labeled **Default model**; administrator model
names still take precedence. The star does not choose a provider or model automatically.

Opening the subscription panel reads saved state without querying every provider. Row refresh and
bounded refresh-all reuse the existing account-scoped cache. A failed lookup retains the last
successful reading and shows its age and failure separately. Recorded quota history contains at most
168 hourly samples from the last seven days; it starts with actual successful observations.
The remaining-quota warning threshold controls in-page notices and is local to the browser.
SIWC's unavailable quota stays unknown. Subscription percentages, credits, and captured OS tokens
are distinct measurements and are never combined into an account-wide spending total.

With SIWC setup enabled, the Workshop validates the private binding's safe catalog before building profiles.
Without setup, the existing single model keeps the runtime's configured account. The Workshop neither
calls the setup catalog RPC nor sends an object selector in that mode. Shared configs from
the catalog carry a server-owned `subscriptionAccountId` as well as the subscription transport tag.
Personal-provider CRUD rejects both fields and strips them from historical personal records.
Previously minted shared bindings check the selected logical profile's current mode on each call,
so disabling one connection also revokes its bindings without disabling another connection that
uses the same physical model. An unknown object ID fails closed.

No provider credential or global account selection is stored in admin configuration. The deployment's
service binding and the existing runtime's per-object account/model/actor policy remain authoritative.
Omitting `management`, or setting it to `"user"`, preserves the original per-user setup flow.
This subscription catalog does not require or emulate a Cloudflare AI Gateway.

For optional SIWC subscription setup in either authentication mode, set `modelBridge.setup` to `"siwc"` and
point `modelBridge.service` at a separately deployed SIWC subscription Worker. That Worker must
provide the `CloudAgentInference` entrypoint and handle login and API requests beneath
`/gatekeeper/subscription`. The router adds `GATEKEEPER_SUBSCRIPTION` for this service through its
existing `/gatekeeper/*` routing. It adds no Workshop Gatekeeper vendor or authentication grant.
For Access, protect this path with the same Cloudflare Access application as the router. For OIDC,
configure the subscription Worker's `OS_SESSION` service binding to the Workshop's private
`SubscriptionSetupSession` entrypoint and pin its administrator issuer, subject and email. The
static setup page uses the existing OS session for every same-origin POST. See
[subscription setup configuration](subscription/README.md) for both examples and session lifetime. The wrapper does
not deploy the subscription Worker or create its provider connections. Open the protected setup
page to add a named connection and connect its SIWC or native Codex provider. Each object keeps
its own login flow and grant. Inference uses the selected protocol without paid API fallback.
Omitting `setup` preserves the existing generated configuration.

## Scoped agent settings

Open **Providers → Agent settings and teams** to manage organization, team, or personal resources.
Select a scope, then add a named OpenAI-compatible backend, skill, MCP server, or plugin.
A backend uses a public HTTPS API base on port 443, including `/v1` when its API requires it.
Supply a write-only API key or explicitly choose **Use no API key**. Changing an existing address
requires a new key or that explicit keyless choice. Model discovery reads `/models` and supported
pagination without running inference, following the [OpenAI model-list contract](https://developers.openai.com/api/reference/resources/models/methods/list). Model IDs retain their provider identity, so identical model
names in different backends remain separate choices.

Teams have one parent and users can join multiple teams. Members receive resources from their own
teams and their ancestors. Parent membership does not grant access to child or sibling resources.
Team administrators manage their descendants. Organization administrators manage organization and
team settings. A personal owner administers their own scope, including explicit delegated access.
Organization administrators do not automatically administer another user's personal settings.

Easy mode exposes resources, team membership, and team administrators. Turn it off to configure
custom roles, user or role delegations, and provider audiences. Both modes use the same server
permissions. Delegated authority cannot exceed the editor's current authority. Provider management
and inference access are separate; sharing requires authority over the provider and its target
audience. Revision checks reject stale writes. Current membership, grants, and provider readiness
are checked again before inference, including previously created gadget bindings.

Skills contain bounded Markdown instructions and load through the native `loadSkill` tool after a
current access check. The bundled **Additional instructions** and **Tool policy** plugins run in
OpenCode's Workerd adapter. Package plugins support pinned npm versions or content-addressed R2
JavaScript bundles through the [plugin installer](plugin-installer.md). The organization administrator
approves each package's exact source and chooses an existing DO with a verified rebuild, or an
isolated Dynamic Worker. Changing the source requires approval again. The portable plugin profile
supports JSON-schema tools and appended system instructions. Native modules, subprocesses, Bun APIs,
and unsupported OpenCode domains fail installation or setup. MCP resources share HTTPS endpoint configuration. Each user
connects and authorizes OAuth separately through the existing connector flow, consistent with
[OpenCode remote MCP configuration](https://docs.opencode.ai/docs/mcp-servers/). Existing observation,
write-approval, and tool restrictions still apply.

Subscription choices include the active protocol's complete bundled SDK model catalog for each
connection. This is a supported-model catalog, not proof of the account's entitlement to every
model. The provider can still reject a model. OpenAI-compatible discovery reports only returned
model IDs; prices, context limits, and capabilities remain unknown unless independently supplied.
Catalog failures retain eligible previous results with an error and observation time. Discovery
rejects oversized or incomplete results instead of silently reporting a partial catalog as complete.
The current limits are 5,000 models per backend, a 1 MiB catalog response, and 4 MiB of serialized
cached data. Larger installations need a paginated catalog API.

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

OAuth JWT with `tokenEndpointAuthMethod: "client_secret_post"` uses the same owner-only
`OIDC_CLIENT_SECRET` export and `--oidc-secrets` option. Public `"none"` clients use PKCE without a
secret, omit `--oidc-secrets` and reject a configured secret. Both use the same deployment order as
OIDC. `--check` runs the OIDC EdDSA and OAuth JWT RS256 native workerd security checks, including
the OAuth JWT HTTP service binding path.

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

In legacy user-managed bridge mode, open Add Model and confirm the displayed subscription. Its model config is
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
