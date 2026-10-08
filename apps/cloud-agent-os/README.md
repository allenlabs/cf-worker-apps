# Cloud Agent OS deployment wrapper

Deploy a pinned [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) with native OpenID Connect
sign-in (Ed25519 issuer with PKCE S256) and an existing Cloud Agent inference service. This package follows the official
[Starter](https://github.com/cloudflare/cloudflare-os-starter)'s private-Worker deployment pattern,
but uses an Auth Gatekeeper instead of Cloudflare Access. It does not copy upstream history or
replace an existing Cloud Agent installation.

The upstream SHA lives in `upstream.json`. All reusable adapters, reviewed patches, tests and build
instructions live here. Customer identities, domains, resource IDs and runtime account selection
belong in a private deployment repository. OAuth grants and client secrets belong only in the
secret manager and Worker secret bindings.

## Boundaries

| Worker | Public route | State or dependency |
| --- | --- | --- |
| Router | One custom domain | Static frontend; internal Workshop and Gatekeeper service bindings |
| Workshop | None | Upstream DO migrations, two KV namespaces, one R2 bucket, Worker Loader and Browser bindings |
| OIDC Gatekeeper | Through router only | New login state; its own client secret and issuer/subject allowlist |
| Context Gatekeeper | Through router only | Upstream DO migrations and a separate KV namespace |
| MCP Gatekeeper, optional | Through router only | Upstream MCP account DOs; separate user-authorized connector grants |

Every Worker has `workers_dev` and preview URLs disabled. The router owns the only custom domain.
The Workshop frontend is built with `VITE_CF_ACCESS_MODE=false`; the backend sets
`AUTH_GATEKEEPERS=oidc` and `DISABLE_PASSWORD_AUTH=true`. Password sign-up/login remain disabled
while the OIDC vendor is configured. The OIDC Gatekeeper verifies identity before the Workshop
creates its email-keyed account. Admin and model-user lists must be subsets of the pinned login
allowlist. Login authorization does not grant access to business data.

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

Use Node.js 24.19+ and pnpm compatible with the pinned upstream's `packageManager`. No additional
runtime dependency is added by the wrapper; overlay packages use the pinned upstream workspace.

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
and the MCP library/configurator builds when enabled. `--check` also drives the OIDC Worker/DO flow
under Miniflare, runs the MCP account OAuth regression suite, and tests the model-configuration UI.
Generated Wrangler files preserve upstream build
rules and DO migrations, and are deleted when the build or deployment exits. `--check` packages
Workers with Wrangler `--dry-run`; it does not create cloud resources or verify a real login.

## Deploy and verify

Register a dedicated confidential OIDC client with PKCE. Its callback is
`https://os.example.com/gatekeeper/oidc/oauth`. Export `OIDC_CLIENT_SECRET` from the secret manager
into an owner-only (`0600`) temporary JSON or env file. The deployment passes its path only to the
OIDC Worker's Wrangler `--secrets-file`, so the first Worker version and its required secret are
installed atomically. The wrapper never reads the secret contents. Supply Cloudflare deployment
authentication from the secret manager, not a tracked configuration file.

```sh
node scripts/build.mjs --config /private/path/deployment.json --deploy --oidc-secrets /private/path/oidc-secrets.json
```

Deployment order is Context, OIDC, optional MCP, Workshop, then Router. The runtime inference
entrypoint must already exist. The wrapper deliberately does not deploy or reconfigure that runtime.
Remove the temporary secret export after deployment. Every explicit deployment requires the secret
file; this avoids an interactive first-deployment prompt or a dummy Worker bootstrap.

1. Confirm `/api` rejects an unauthenticated session and login offers only the configured SSO.
2. Sign in as an allowed identity, reload, and confirm `/admin` is restricted to configured admins.
3. Create an agent model profile using the configured bridge model; test one short model response.
4. Connect the permitted MCP endpoint and call a specifically granted harmless read tool.
5. Confirm every internal Worker has no public route and that browser/network output contains no credentials.

For model setup, open Add Model and confirm the displayed Codex subscription. Its model config is
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
