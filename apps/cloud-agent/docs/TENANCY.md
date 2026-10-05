# Customer isolation

Cloud Agent supports separately configured customer installations. Each installation has a fixed `TENANT_ID` and a display-only `TENANT_NAME`. A request cannot choose its tenant through a query parameter, header, or model tool argument.

## Installation boundary

Each customer receives a Worker, its Assistant, Credentials and GitHubAuthoring Durable Object namespaces, an SSO registration, and its own source-channel and GitHub App configuration. This is the supported deployment model. Automatic customer onboarding and shared administrator roles are not implemented.

Durable Objects pin the tenant on first access. Changing `TENANT_ID` against an existing namespace fails instead of exposing an old customer's account, draft or conversation. Preserve the pinned tenant, namespace identities, token wrapping key and encryption context during an update. A new customer requires a new installation.

D1 queries include both the tenant ID and the native object ID. Session and entry IDs are local to that pair. The Manager directory also includes the source channel ID because two channels can use the same Manager ID. Display names never authorize administrator actions or select model credentials.

An installation can use its own D1 database. A shared database has application-level tenant filters, not an independent database security boundary. Use separate databases when customer policy requires separate backups, retention or operator access.

## Data ownership

| Data | Owner and persistence |
| --- | --- |
| Pi conversation journal, sessions and message history | Tenant and native object, in D1 |
| Manager display name | Tenant, channel and Manager ID, in D1 |
| Subscription credentials and verified identity | Installation Credentials Durable Objects, encrypted |
| Runtime coordination and account/session pins | Installation Durable Objects |
| Git draft files and publication receipts | SSO administrator and authorized repository source, in GitHubAuthoring Durable Objects |
| Published plugin and skill files | Explicitly reviewed GitHub commit |

Names and conversation content are untrusted text. The management screen escapes them and separates them from settings. The model does not receive a Git publication capability.

## Public product and private installation

The public repository contains reusable runtime code, migrations, generated fixtures, tests and architecture documentation. Branding, domains, channel IDs, SSO principals, Cloudflare resource IDs, repository installation details and hosted verification evidence belong in the private deployment repository. Credentials belong in the secret manager and platform bindings, including for private installations.

Publish reusable changes here first. Adopt the reviewed public commit in a private installation before applying that installation's configuration. This keeps customer-specific tuning out of the generic product history.
