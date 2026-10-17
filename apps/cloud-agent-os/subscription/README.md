# Fresh SIWC subscription connection

This private Worker exposes the Korean connection page at `/gatekeeper/subscription`. Bind it to the existing OS router as `GATEKEEPER_SUBSCRIPTION`. The native router already forwards that path. Set `PUBLIC_ORIGIN` to the OS origin. With `SUBSCRIPTION_AUTH_MODE` omitted or set to `access`, protect the whole origin with the same Cloudflare Access application. This Worker separately verifies the Access JWT's signature, issuer, audience, expiry and its own pinned administrator email. It has no public route or inference HTTP endpoint.

Deploy it under a new Worker name with a new `Credentials` namespace. It re-exports the public Cloud Agent `Credentials` and `CloudAgentInference` implementations. The only DO binding and migration are `Credentials`. It never creates an Assistant, PiHarness or another agent loop. The imports include shared runtime dependencies; the selected connection methods only pin `TENANT_ID` and use DO storage. No D1, Channel Talk, SSO or GitHub binding is required.

The page asks for the expected personal ChatGPT email and explicit subscription usage approval. It pins the email's SHA-256 hash with `configureAccount` and calls `Credentials.start(true)`. A fresh namespace starts with `dynamic_agent_client`. The user opens OpenAI's authorization link in their browser. The official flow expects a local callback listener. This page uses the repository-tested manual adaptation: the user copies the full `http://127.0.0.1:1455/auth/callback?...` address into the page's form. Never ask for that address in chat. The form submits it only in a bounded same-origin JSON POST body and clears the field immediately. It does not navigate to, log or persist the callback URL in browser storage.

Readiness comes from `status.siwcInferenceReady`. The protected page displays only the verified email, plan label and workspace name for the user's account check. Those labels do not grant permission or prove a personal workspace when the provider supplies no workspace name. Repeating login preserves the email/subject/workspace pins and an existing grant. There is no reset or disconnect action.

For OIDC OS login, copy `wrangler.oidc.example.jsonc` into private deployment configuration. Set `SUBSCRIPTION_AUTH_MODE=oidc` and bind `OS_SESSION` to the OS Workshop's named `SubscriptionSetupSession` entrypoint. Pin `SUBSCRIPTION_ADMIN_ISSUER`, `SUBSCRIPTION_ADMIN_SUBJECT` and `SUBSCRIPTION_ADMIN_EMAIL` to that administrator's exact verified OS identity. Every POST verifies the existing OS session through this private binding and compares all three pins before any Credentials call. Access headers and browser-supplied identity claims cannot authorize this mode. The verifier exposes no HTTP or public browser RPC route.

An OIDC GET serves a static shell without account data. The forms stay disabled until an authenticated status POST succeeds. The page reads the OS's existing same-origin `localStorage.authToken` for each POST and sends it only in the `Authorization: Bearer` header to this Worker's same-origin paths. It does not write browser storage, show the token or send it to OpenAI. Unauthorized requests disable the forms and show a fixed `/` OS sign-in link. Old sessions without stored OIDC provenance must sign in again. This follows the OS session lifetime: sessions have no automatic expiry, and OS logout clears the browser token rather than revoking the server record. The verifier rejects unknown or deleted session records; it does not add IdP expiry checks or a revocation API.

For Access, copy `wrangler.example.jsonc` into private deployment configuration. Pin the Access issuer/audience and administrator email for Access mode. Keep OS origin, tenant, model and inference user list in the selected configuration. Supply a fresh 32-byte base64url `TOKEN_WRAPPING_KEY` through a Worker secret binding, and a stable instance-specific `TOKEN_WRAPPING_AAD`. Both inference provider settings must stay `siwc`, and the account ID must stay `owner`. The OS's private `CODEX_BRIDGE` service binding targets this Worker's `CloudAgentInference` entrypoint. No credential, account selection or model override comes from the browser.

## Local verification

Keep dependency installation outside the checkout. From this directory, use a unique temporary dependency directory and the public source repository:

```sh
subscription_deps=$(mktemp -d /tmp/subscription-deps-XXXXXX)
cp package.json "$subscription_deps/package.json"
npm install --prefix "$subscription_deps" --ignore-scripts --no-audit --no-fund
export SUBSCRIPTION_DEPENDENCIES="$subscription_deps/package.json"
export SUBSCRIPTION_SOURCE_ROOT=/path/to/public/allenlabs-cf-worker-apps
node check.mjs
node build.mjs /tmp/subscription-build/index.js
```

`build.mjs` resolves the public cross-app imports in a package-external stage, embeds SQL as text, then uses Wrangler's supported Workers conditions and Node compatibility bundler in dry-run mode. It never deploys. `check.mjs` drives actual Miniflare/workerd with generated Access/OpenAI keys and fully mocked outbound endpoints, plus the Korean form under jsdom. It checks Access and OIDC authorization before any Credentials call, request bounds, a fresh direct SIWC grant, immutable account pins, verified readiness, private inference, sanitized errors and the absence of callback/token persistence and logging. It neither contacts a live authorization service nor validates a real subscription. Generated bundles and synthetic fixture state stay in unique temporary directories.
