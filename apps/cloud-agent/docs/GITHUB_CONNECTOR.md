# GitHub App connector

The implemented connector lets a signed-in Super Admin select an installed repository, existing branch, allowed folder and connected subscription account. The management page provides text reads, an editor, Pi-assisted staging, an exact preview and an explicit **Save to Git** action. Native GitHub HTTPS requests publish one atomic commit; there is no clone, container, shell or separate push process.

Git publication and skill activation are separate operations. A committed `SKILL.md`, plugin source or extension does not execute or enter the approved skill catalog. Existing Channel Talk and manual subscription-test conversations keep their original tools.

## Configure an installation

Supply the following deployment settings privately:

| Binding | Value |
| --- | --- |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_CLIENT_ID` | App client ID; if omitted, App ID is the JWT issuer |
| `GITHUB_INSTALLATION_ID` | Numeric installation ID |
| `GITHUB_INSTALLATION_OWNER` | Exact installation owner login |
| `GITHUB_APP_PRIVATE_KEY` | Secret binding containing an RSA **PKCS8** PEM private key |

GitHub's downloaded RSA private key can be PKCS1. Convert it to PKCS8 outside the Worker before provisioning the secret; native WebCrypto imports PKCS8. Preserve the existing `Assistant` and `Credentials` namespace IDs, wrapping key, AAD, OAuth grants and SSO/channel identity settings. The example Wrangler file adds only the `GitHubAuthoring` SQLite class with migration `v2`.

The broker verifies the App ID/client ID, installation ownership and unsuspended status. It checks those again before using a cached token. Inventory requests ask only for Contents read and Metadata read. Repository read/write requests select one numeric repository ID and request only Contents read/write plus Metadata read. Other App permissions are not passed to the writer. The App installation must authorize these permissions; App configuration can have broader grants without exposing them through this runtime.

All requests use fixed `https://api.github.com` endpoints, reject redirects and bound response bytes before JSON parsing. Private keys, App JWTs and installation tokens stay in host code and are absent from drafts, tool results, preview plans, receipts and audit records. Account selection is pinned when an authoring source is registered; disconnecting that account blocks its drafts rather than switching accounts.

## Private draft ownership

A host hash of the verified SSO issuer and stable subject identifies the actor. Registering a source pins the actor, numeric repository ID, current repository name, existing branch, folder prefix, subscription account and policy generation. The authoring DO name derives from actor/source/generation. The immutable context is never a model argument.

Each authoring DO holds its own Pi transcript, base commit, draft version, original/staged text, local write receipts, frozen preview plans and publication receipts in SQLite. Every admin route revalidates SSO. Every authoring operation and model tool rechecks the source, actor policy and connected account through the owner Credentials DO. Another administrator using the same subscription cannot read this draft. Disabling a source blocks its old draft permanently; register a new source to start another draft.

Pi receives exactly three draft tools:

- `github_draft_read(path)` reads one staged or pinned-base file and returns the current version.
- `github_draft_write(path, content, expectedVersion)` stages one file with a durable exact-input receipt.
- `github_draft_preview(message)` freezes the current destination, base, version, headline and exact original/new text into a plan hash.

These schemas contain no actor, account, repository, branch, URL, installation, token or arbitrary query. Pi cannot publish. The management page's separate save button sends only a selected source, reviewed plan hash and operation ID. Authoring inference contributes native Pi token totals to the selected account's existing usage aggregate.

## Text and repository limits

Accepted suffixes are `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.css` and `.toml`. Files must be regular Git tree blobs with mode `100644` and valid UTF-8. Reads use the exact base commit, not the moving branch. Symlink mode `120000`, submodule mode `160000`, executable mode `100755`, LFS pointer files, malformed Unicode, control bytes, `.git`, `.env`, workflow segments, traversal, percent encoding and backslashes are rejected. Paths use bounded ASCII segments. Publishing code does not execute it.

Limits are 64 KiB per file, 32 staged files, 256 KiB staged content and 256 KiB original text, 200 listed files per selected folder and a 1 MiB response/history envelope. Repository inventory is paginated in pages of 50, with at most 100 pages. Recursive Git tree responses must be complete and within the envelope; large repositories can exceed this initial reader's limit. The management transcript displays at most 100 entries and 128 KiB with explicit omitted counts; the full durable history is retained. Initialization and publication do not load history. Pi’s current active-history API still materializes the transcript for display; cursor-based history access is the upgrade path if long-lived authoring conversations approach DO memory limits. Drafts are additions/replacements only. There is no file deletion, branch creation, force update, rebase, merge, repository creation, OAuth user flow, webhook consumer or general management proxy.

## Atomic publication and recovery

Preview freezes the full destination, base OID, draft version, commit headline and sorted exact files. Save rejects an edited draft or changed policy. After resolving credentials, the DO persists an `unknown` receipt and exact GraphQL payload before the remote mutation. It then calls `createCommitOnBranch` with `expectedHeadOid`; GitHub checks the branch head atomically. The mutation adds all files in one commit. `clientMutationId` is correlation only.

A successful response must contain a commit OID. The broker reads every changed file at that OID and verifies its exact text before recording completion, advancing the draft base and clearing staged files. Replaying the same operation ID/plan returns its stored receipt without another mutation. Changing that operation's arguments is denied.

A transport loss, malformed response, verification failure or GraphQL rejection remains `unknown`. A head conflict therefore preserves the draft and requires remote inspection; this conservative implementation does not classify GitHub errors as guaranteed no-op. Unknown receipts survive restart and block additional edits, AI requests and new publications. The UI keeps the same publication operation ID while retrying receipt lookup. There is no automatic resend, blind receipt clearing or reconciliation button. An administrator must inspect GitHub before a future recovery feature can safely resolve it.

## Native verification

Run from the repository root:

```sh
npm run -w @cf-worker-apps/cloud-agent typecheck
npm run -w @cf-worker-apps/cloud-agent test
npm run -w @cf-worker-apps/cloud-agent test:coverage
```

`tests/workers/github-check.mjs` bundles the actual admin routes, broker and authoring Agent in workerd. It generates RSA and SSO keys and intercepts every outbound GitHub request. It verifies SSO/CSRF denial, private actor/source separation, token/JWT containment, fixed endpoint behavior, tree modes and UTF-8/size bounds, TypeScript and Unicode publication, Pi draft tools, version races, stale preview, bounded transcript display with long-history publication, multi-file compare-and-swap, exact replay, response loss plus restart, disabled sources/accounts and removed administrators. Its commit mutations are mocked; it performs zero external GitHub writes. A live deployment read and deliberately reviewed private fixture commit provide separate installation evidence.

`test:coverage` retains the native workerd Profiler check. A runtime lacking the Profiler API exits nonzero after behavior checks; no percentage or application-wide coverage is claimed in that case.
