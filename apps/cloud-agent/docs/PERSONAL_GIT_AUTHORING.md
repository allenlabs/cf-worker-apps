# Personal plugin authoring without containers

Status: architecture and a standalone native runtime feasibility check. The current [GitHub App connector](GITHUB_CONNECTOR.md) implements the Super Admin subset: private drafts and Pi transcripts, bounded text editing and explicitly reviewed atomic publication. Member self-service, catalog promotion and automatic plugin activation remain design work. The flow is to ask Pi to create or edit a file, inspect the exact preview and save it to an authorized Git source.

## Select the native GitHub writer

| Option | What runs in the DO | Fit |
| --- | --- | --- |
| GitHub `createCommitOnBranch` | Bounded text draft, validation and one HTTPS GraphQL mutation with an expected head | First choice for skills, references and templates |
| Pure JavaScript Git | Virtual filesystem, `.git`, index, local commits and HTTPS fetch/push | Add when local history, branch or merge operations are required |

[GitHub's commit mutation](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch) creates a commit and advances the existing branch in one operation. Its `expectedHeadOid` guards the base revision. Use it for regular file additions and replacements; file deletions require an explicit reviewed change set. The UI can call this action "Save to Git". It is not a local Git CLI invocation followed by a separate push, but the resulting commit is published to the remote branch.

The Git Database REST APIs remain an option when file modes or explicit author control are necessary. REST `PATCH refs` with `force:false` checks fast-forward ancestry, not an exact expected old head. A REST-built commit can use [GraphQL `updateRefs` with `beforeOid`](https://docs.github.com/en/graphql/reference/git#updaterefs) for guarded publication. Do not substitute a read-then-force-false sequence for an atomic old-head condition.

Cloudflare's newer preview [Computer Workspace](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md) also provides `createGitClient()` over its SQLite virtual filesystem without a shell or backend. Its Git implementation uses isomorphic-git and requires Workers compatibility setup. It is a separate filesystem implementation from the earlier shell Workspace; the earlier R2 overwrite issue must not be attributed to this new VFS. Full Git introduces clone/pack/history work: selected checkout paths do not eliminate fetching the tip tree's other blobs. The API writer avoids that work and new Git dependencies for the initial text-authoring path.

No container or Sandbox is needed for these bounded authoring and publication operations. Script execution, native builds and arbitrary Linux processes remain separate capabilities. The model's existing subscription-backed provider and GitHub authorization remain separate credentials.

## Ownership and catalogs

Extend the [common and organization plugin model](COMMON_ORG_GIT_PLUGINS.md) with personal scope:

```text
common/<plugin-id>@<digest>
org/<organization-id>/<plugin-id>@<digest>
personal/<organization-id>/<member-id>/<plugin-id>@<digest>
```

A host-authorized personal profile selects common, organization and the owner's personal revisions explicitly. Preserve duplicate-name rejection and existing catalog limits. Personal publication must not silently replace an organization's approved plugin or change its grants. Promotion from personal to organization or common scope is a separate administrator action, with the existing source and approval review.

Personal drafts belong to an owner-scoped authoring DO and Pi conversation, separate from the team root's shared transcript and files. A team root can contain multiple staff members; keeping only file prefixes separate would still disclose private drafts through its shared model context. The existing team-root Workspace sharing policy remains valid for team work. The personal authoring page/session supplies the different ownership boundary.

Derive member identity from authenticated issuer and stable subject plus host-approved organization membership. For Channel Talk entry points, require a verified sender-to-member mapping. Message text, model arguments and a GitHub display name cannot choose the owner. The current service has Super Admin SSO and one installation. Its connector routes administrator authoring to private actor/source Durable Objects; member sessions, personal roles and sender-to-member mapping still need implementation before this feature is offered to staff.

A private Git repository can have many readers. A personal directory inside an organization repository constrains host writes but does not hide those files from repository collaborators. Use an individually authorized private repository when repository-level personal confidentiality is required. The authoring UI must show the registered destination's visibility and collaboration scope before publishing.

## Host-controlled tools and editor

Give the authoring Pi only bounded draft operations: read a selected file, write a selected text file, inspect its draft diff and publish a frozen change set. A thin host adapter maps tool names to the owner's draft and registered destination. The model never receives a GitHub token or arbitrary remote URL, ref, user identity or public-promotion option.

The management editor and Pi use the same draft/version and publication API. User-facing actions can be "Create my skill", "Edit", "View changes" and "Save to Git". Personal authoring does not require more settings commands in the staff `/ai` interface. Administrators still manage accounts, credentials, source registration, publication permissions and organization/common activation.

The destination is registered by repository ID, allowed ref and permitted plugin paths. Bind writer authority to an authenticated actor and credential reference. Link the SSO principal to a verified numeric GitHub user identity when using personal authorization. A failed user credential must not silently fall back to the installation writer. GitHub credentials can be one of:

| Credential | GitHub authority and attribution |
| --- | --- |
| User-authorized GitHub App user access token | Acts within both App permissions and the user's repository access; appropriate when commits must belong to that GitHub user |
| Administrator-approved App installation writer | Service publication under its credential identity; authenticated member ownership stays in the private service audit |

The read-only importer remains read-only. Writing needs an explicitly authorized writer credential with Contents write access to selected repositories and must obey branch protection/rulesets. This design does not configure a bypass. Commit authorship for `createCommitOnBranch` follows the credential owner and cannot be supplied as a model-controlled author field. Never attribute a service-token commit to a human by copying their email into commit metadata. See [GitHub user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user) and [commit authorship](https://docs.github.com/en/graphql/reference/commits#authorship).

## Draft and publication lifecycle

1. Read the registered source at an exact base commit into a bounded owner draft. Do not clone all repository files into the personal session.
2. Pi or the editor changes selected regular text files. Validate the plugin, size, paths, source policy and excluded data before any remote upload.
3. Freeze the base head, draft version, file hashes and commit message into one publication plan. The displayed preview and executed plan must have the same hash. Keep drafts isolated by owner and serialize publication attempts for a destination.
4. Persist a receipt before sending `createCommitOnBranch`, using the frozen head as `expectedHeadOid`. If the branch changed, retain the draft and request a new-base review instead of overwriting remote work.
5. Store the returned commit in the receipt, verify the published result and let the existing importer produce a staged immutable plugin revision. Git publication and runtime activation remain separate.

Freeze repository, ref and all changed paths in the plan. A model cannot change the target after preview. A concurrent draft edit produces a new draft version and does not alter an in-flight plan. Personal write permission does not confer organization/common publication or activation authority.

DO storage and GitHub are not one transaction. Mark the publication pending or uncertain before remote I/O. A completed receipt can return its existing result on replay. A response loss, malformed response or interruption after sending produces an unknown outcome; do not automatically retry as a new commit. `clientMutationId` is correlation, not an idempotency guarantee. A later reconciliation must verify the actual remote commit against the expected base, plan and operation audit, with bounded ancestry handling. If it cannot establish the outcome, show it as unresolved. Ruleset rejection or an expired grant must not make an uncertain request appear safe to replay.

Native commit creation is one guarded remote operation, but the entire authoring flow is not universally exactly once. A source's staged review, skill validator and operation revision pin still apply after publication. Revoking personal write access stops future writer calls without claiming to undo a prior Git commit.

## Record sketch

```ts
// Design only. Production identity, editor and writer routes are not implemented.
type PersonalDraft = {
  organizationId: string;
  memberSubject: string;
  draftId: string;
  version: number;
  sourceId: string;
  baseCommit: string;
  files: Array<{ path: string; content: string; sha256: string }>;
};
type GitPublicationPlan = {
  operationId: string;
  draftId: string;
  draftVersion: number;
  planHash: string;
  repositoryId: number;
  ref: string;
  expectedHead: string;
  message: string;
  changedFiles: Array<{ path: string; contentBase64: string }>;
};
// writeDraft(authenticatedPrincipal, draftId, expectedVersion, fileChange)
// previewDraft(authenticatedPrincipal, draftId)
// publishPlan(authenticatedPrincipal, planHash, operationId)
```

Keep writer policy and receipts in a small host module when implementing. The initial API path can use native fetch, WebCrypto and DO storage. The new authoring DO is warranted by personal ownership and conversation privacy; it is not a replacement for existing team-root or credential DOs. Its credential references resolve in the existing host, not in draft files.

## Feasibility check and limits

The [runnable check](../tests/git-authoring/README.md) runs a real workerd SQLite Durable Object and the installed PiHarness. A scripted faux model issues the real tools; a mocked GitHub endpoint receives their mutations. The check passed skill and reference writing/reading, a multi-file commit request, persistence across a native runtime restart, stale-base conflict handling, completed receipt replay and input-mismatch denial, and response loss that remains unknown after restart. The fixture made five mock requests, accepted four mock commits and made zero external GitHub writes.

Separate fixture DOs do not share files; a bound profile cannot be replaced. Traversal, unsupported content and oversized files are denied. The model's tool schema has no remote destination or credential arguments, and the host supplies the fixed repository, branch and personal path prefix. These are storage and tool-boundary checks, not authenticated member-routing proof. Fixture control routes are deliberately unauthenticated and must not be deployed.

The check does not validate real GitHub writer grants, branch rules, live remote commit acceptance, real model generation or a deployed UI. It covers bounded text additions only; deletion, remote import, reconciliation, branch creation and plugin activation remain outside the fixture. Those capabilities require the subsequent service implementation and a selected GitHub writer connection.

Publish the reusable design and runnable check publicly first with generated fixtures. Adopt the reviewed public files privately afterward; keep actual GitHub/member mapping, credentials, repositories and authoring data in the private deployment.
