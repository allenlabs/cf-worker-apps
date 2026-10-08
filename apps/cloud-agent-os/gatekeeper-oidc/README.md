# OIDC sign-in gatekeeper

An auth-only Cloudflare OS gatekeeper for an Ed25519 OIDC issuer. It exposes no agent resources and never returns provider credentials to the Workshop or browser. It uses the upstream connect handshake and handoff, PKCE S256, nonce-bound ID tokens, and an exact email/subject allowlist. Every attempt is single-use and expires in ten minutes. Only the verified email is available to the Workshop while its login callback runs; the temporary identity is then removed.

Bind the Worker as `GATEKEEPER_OIDC` in the router and Workshop backend, using the `GatekeeperVendor` entrypoint for backend RPC. Configure `AUTH_GATEKEEPERS=oidc` and `DISABLE_PASSWORD_AUTH=true` on the backend. Disable the starter's Cloudflare Access mode and corresponding frontend build flag. Preserve the Workshop's signup policy and `ADMINS` configuration: this gatekeeper does not grant administrator or clinical data access.

Required variables: `PUBLIC_BASE_URL` (HTTPS origin), `OIDC_ISSUER` (exact issuer without trailing slash), `OIDC_CLIENT_ID`, and `OIDC_ALLOWED_IDENTITIES` (nonempty JSON array of `{ "email": "person@example.invalid", "subject": "issuer-subject" }`). `OIDC_CLIENT_SECRET` is a Worker secret. Optional variables are `OIDC_DISPLAY_NAME`, `OIDC_LOGIN_URL` (fixed trusted HTTPS login entry), and `OIDC_LOGIN_SITE`. The latter adds `sitename`; the authorization URL is sent as `callbackURL`. Deployment configuration, rather than request parameters, owns these values.

Register a dedicated confidential OIDC client with callback `${PUBLIC_BASE_URL}/gatekeeper/oidc/oauth`, scopes `openid profile email`, grant `authorization_code`, response `code`, token authentication `client_secret_basic`, PKCE required, and consent enabled. Do not reuse another application's client or enable dynamic registration globally. Only same-origin discovery endpoints and EdDSA/Ed25519 signing keys are supported by this pilot adapter.

The Worker exports `GatekeeperVendor`, `GatekeeperUserImpl` and the SQLite Durable Object `OidcLogin`. Enable `allow_irrevocable_stub_storage` for the upstream callback capability. Use a new namespace for this pilot; do not change an existing deployment's DO identities.

Sign-in failures return a fixed category and HTTP status. The DO's `begin()` and `complete()` return structured results so these diagnostics survive RPC, which does not preserve custom exception classes or properties. Provider error descriptions, credentials, codes, nonces, identities, URLs and raw exceptions are never returned or logged. Unknown failures use the category of the stage that failed; a category identifies where to investigate, not the underlying cause.

| Category | HTTP status | Meaning |
| --- | --- | --- |
| `sign_in_attempt_expired` | 400 | The nonce expired, was consumed, or does not match. Start a fresh attempt. |
| `identity_provider_unavailable`, `identity_provider_protocol_mismatch`, `identity_provider_endpoint_mismatch` | 502 | The provider request or discovery validation failed. |
| `token_client_rejected`, `token_grant_rejected` | 400 | The token endpoint returned the standard `invalid_client` or `invalid_grant` error. |
| `token_exchange_failed` | 400 | Other token endpoint, network or token response failure. Nonstandard errors, including `invalid_verification`, remain in this category. |
| `invalid_identity_token`, `invalid_identity_keys`, `identity_subject_mismatch` | 400 | ID token verification or identity binding failed. |
| `verified_email_required`, `identity_not_allowed` | 403 | The identity did not meet the verified-email or exact email/subject policy. |
| `sign_in_handoff_failed`, `invalid_sign_in_handoff` | 502, 400 | The Workshop callback failed or returned an unexpected origin. |
| `sign_in_cleanup_failed` | 502 | Transient state cleanup failed; no successful handoff page is returned. |
| `invalid_sign_in_configuration`, `sign_in_failed` | 503, 400 | Invalid configuration or an otherwise unclassified failure. |

Callback claims remain single-use, including failed exchanges. Cleanup runs after every claimed callback; a failure to clean up replaces the result with the fixed cleanup category. Browser handoff confirmation remains required for session delivery. Diagnostic categories do not authorize a session or relax verification.

Run `node tests/check.mjs /absolute/path/to/cloudflare-os` after installing that checkout's dependencies. The check bundles this source and drives the real Worker/DO RPC flow under Miniflare, with a fixture callback and a mocked external identity provider. All identities and keys are generated test fixtures. It verifies signed callbacks, exact failure categories and statuses across RPC, redacted token/JWT/handoff/cleanup failures, replay, issuer/audience/nonce/allowlist failures, expiry, and cleanup. It does not exercise the full Workshop callback and browser confirmation or claim to test a hosted SSO login or change the Workshop's own session lifetime.
