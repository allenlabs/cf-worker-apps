# Authenticated agent testing

Investigation, 2026-10-10. Local authentication automation and hosted diagnostic delegation solve different needs. This document proposes a bounded hosted capability; it does not enable one.

## Local integration and browser tests

Better Auth's bundled `testUtils()` can issue signed test cookies through a separate test-only auth instance. Its helpers create sessions in the configured adapter, so an in-memory or isolated disposable adapter is essential. Do not attach that test instance to a production auth database or expose its privileged context through HTTP.

Use synthetic identities and secrets, block unexpected network traffic, and verify ordinary session lookup plus anonymous, malformed, revoked and expired credential rejection. A test helper proving session lookup does not prove site membership, an OAuth handoff or real provider inference. Keep those acceptance checks separate.

The [official test-utils documentation](https://better-auth.com/docs/plugins/test-utils) recommends a separate test-only auth instance. Verify installed package behavior rather than assuming the latest documentation matches its API.

## Hosted diagnostic delegation

An ordinary browser session grants ordinary account privileges. The [bearer plugin](https://better-auth.com/docs/plugins/bearer) changes how such a session is transported; it does not restrict it to testing. A narrow diagnostic permit should be a distinct capability:

1. A normally authenticated original principal authorizes a diagnostic run. Check current site authorization, origin/CSRF policy and absence of prohibited authentication impersonation.
2. Bind the permit to the original issuer/subject, existing verified email pins, canonical site/environment, one diagnostic purpose and an expiry of at most five minutes. Generate a high-entropy single-use secret, retain only its digest and support revocation. Do not issue a general browser session.
3. Redeem only through a dedicated server-side diagnostic handler. Reject other routes, sites, principals, replay and expired/revoked permits, and recheck current authorization. Atomically consume the permit before inference; concurrent redemption and retries after failure require fresh authorization. A client-supplied email is not an authenticated principal.
4. Construct the entire synthetic model context on the server: fixed text, no conversation/history, ambient skills/resources or tools. Fix the account/model policy, call count, deadline and byte/frame limits server-side; do not promise an output-token cap a provider does not enforce. Return bounded transport observations and emit a fixed success marker only after a valid completed provider stream. Exclude customer reads, business writes, account/provider changes and OAuth grant replacement.
5. Preserve the normal authentication, principal binding and conversation authorization paths. Deleting the diagnostic capability must not change ordinary sign-in behavior.

This requires custom implementation; Better Auth does not automatically supply these restrictions. Permit state, user scope, inference usage and hosted activation need explicit authorization. A dedicated test identity remains an alternative but must receive normal approved membership and login policy. Do not create another user's production session through privileged test helpers.

## Diagnosing a provider failure

Authentication automation enables controlled comparisons but does not fix an upstream inference rejection. Record only explicitly allowed primitive diagnostics; do not expose tokens, request bodies, user IDs, URLs, raw errors or response HTML. Change one evidenced cause at a time, and distinguish synthetic transport checks from actual provider acceptance.
