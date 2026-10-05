# Repository content for Pi

This is a proposed integration for supplying an approved private repository's documents to Pi. It is not an implemented R2 importer or a deployed storage binding. The existing text-skill path can already serve small, reviewed instruction bundles.

## Choose storage by use

| Content | Storage | Current support |
| --- | --- | --- |
| Small approved instructions and references | Versioned skill catalog in the Credentials DO | Implemented through `activate_skill` and `read_skill_resource` |
| Large repository snapshots and attachments | One private R2 bucket per installation | Proposed |
| Conversation, account pin and operation state | Assistant and Credentials DO SQLite | Implemented |
| Generated working files | Per-root Workspace, with optional R2 for large objects | Future execution work |

Reuse the existing catalog when it fits. The current management validator limits each text file to 64 KiB, each skill bundle to 256 KiB, and the active manifest to 1 MiB. It permits 20 catalog entries and excludes script resources. R2 is useful for shared snapshots, larger references and retained artifacts; it is not required merely to hold a few Markdown skills.

## Publish immutable approved revisions

Keep Git as the authoritative source. An administrator selects a commit and an explicit path allowlist. A publisher resolves permitted files at that commit, verifies their content and produces a manifest containing repository provenance, revision, path, byte size, media type and SHA-256.

Store a published revision under `sources/<source-id>/<commit-sha>/`. Upload and verify the complete snapshot before activating its manifest in the control DO. Retain prior snapshots while operations reference them. Capture the approved source revision in the operation snapshot so retry or recovery reads the same bytes. Do not overwrite a running operation's source through a mutable `latest` object.

The model receives an approved logical document path, not a bucket key or GitHub credential. A reader enforces the manifest allowlist, rejects traversal, bounds output, verifies the object hash and returns provenance with the text. Missing or changed content fails explicitly. Reading documents does not grant the powers described by those documents.

## Reuse platform capabilities

Cloudflare Workers can access R2 through a server-side [bucket binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). This avoids distributing S3 credentials to the model. Keep bucket public access disabled and expose only authenticated, bounded application readers. [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) grant the Worker bucket capabilities; the application must still restrict what the model can request.

The installed Agents SDK includes an [R2 SkillSource](https://github.com/cloudflare/agents/blob/main/packages/agents/src/skills/r2.ts). It expects `<prefix>/<skill>/SKILL.md`, so an arbitrary repository tree must be selected and packaged before it becomes a catalog. Using that source directly also requires the application's approval, text, size and script constraints; it does not automatically replace the current management validator.

R2 provides [strong consistency for direct binding reads and writes](https://developers.cloudflare.com/r2/reference/consistency/). Immutable keys and a final manifest activation still prevent partially published revisions and concurrent overwrites from changing an operation's context.

## Separate shared references from working files

One installation-wide bucket can share read-only source snapshots across roots. Store generated artifacts under `artifacts/<tenant-id>/<root-id>/<operation-id>/`. Prefixes are application isolation rules, not independent authorization boundaries. Validate scope before every read or write; do not let the model choose arbitrary prefixes.

Use the existing DO transcript and state for conversations. For filesystem work, Cloudflare's experimental [Workspace](https://github.com/cloudflare/agents/blob/main/packages/shell/README.md) combines SQLite with optional R2 and pure-JavaScript Git. It does not provide a Linux process environment. Running Python, package managers or repository tests requires an explicitly configured [Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/) or another execution service. R2 mounts also differ from local filesystems for locks, rename and permissions; see [Sandbox files](https://developers.cloudflare.com/sandbox/files/).

## Verify the integration before activation

The smallest native check must prove idempotent publication, denial of unknown and traversal paths, rejection of hash mismatch, isolation between artifact roots, and preservation of a captured revision after update and restart. Verify real model calls to the reader separately from mocked publication checks.

Generic publisher, manifest, reader and checks belong in the public implementation. Actual repository contents, selected paths, bucket names and hosting permissions belong in the private deployment. Exclude credentials, historical implementations and duplicate mirrors; review source-specific authority rules rather than importing another channel's trust policy.
