# Native Agent Memory for a private, single-user OS

This mode adds automatic namespace/profile provisioning, checkpoint ingestion of complete saved
text conversations, and per-bot memory to `feat/bdots-bot-workspaces`. It is opt-in deployment
configuration. Without it, the existing connected-MCP preference and deployment behavior remain.
This document supersedes the no-automatic-ingestion statements in BOT_WORKSPACES.md **only when
native mode is configured**. It does not change the pinned Cloudflare OS or replace OpenCode.

## Enable once in private deployment configuration

Add this field to the existing deployment JSON, outside the public repository:

```json
{
  "agentMemory": {
    "namespace": "private-os-memory",
    "capture": "all-conversations"
  }
}
```

The deployment must allow exactly one login identity. Its existing verified account is the memory
owner; no user identity, token, account ID, or real namespace is hard-coded in the public code.
Embedded site deployments are refused. Use distinct namespaces for development and production.
The account must have Agent Memory access and the deployment token must have appropriate Agent
Memory permissions. This code cannot grant product access or create those permissions.

The generated Workshop configuration contains a native `agent_memory` binding named
`OS_AGENT_MEMORY`. Runtime code receives that binding, never the Cloudflare account API token.
`--deploy` verifies the namespace and creates it if missing, with read-back after creation or a
409 race. This happens after the build and before Worker uploads. `--check` and `--plan` make no
namespace requests. Frozen-artifact uploads use the same provisioning helper only after verifying
the sealed deployment digest and writing the exclusive upload-attempt marker. They preserve the
existing module/configuration checks and do not rebuild or alter the sealed artifacts.

```sh
npm test
npm run typecheck
node scripts/build.mjs --check --config /private/deployment.json
# Use the existing deploy/verified-artifact workflow after its checks pass.
```

## Bot tagging that matches the real API

The documented ingest API does not offer arbitrary `tags` or application metadata fields. Use:

| Level | Meaning | Stable key |
| --- | --- | --- |
| Namespace | OS installation/environment | Deployment configuration |
| Profile | One owner's bot | `bot-` + SHA-256 of a versioned tuple containing verified owner and bot UUID |
| Session | One workspace conversation | `s-` + 60 hex characters of a versioned workspace/chat hash |

Profile keys are 68 characters and sessions are 62 characters, within the documented 100/64
limits. Names and revisions do not enter the profile key. Renaming/editing/archiving a bot retains
its memory; duplicating a bot creates a new UUID and therefore a new profile. Non-bot chats use
that owner's separate default profile (`botId: null`). No recall crosses profiles. This is
isolation, not a flat tagging/filter system. Combining memories from several bots would need an
explicit authorized fan-out; it is not implemented here.

`getProfile()` lazily provisions a profile at first ingest or recall. The local queue also stores
`botId`. Each submitted content envelope carries bot ID, chat/sequence, source artifact hash,
Unicode-safe offsets and EOF. These are ordinary message content, not undocumented API fields.
There is no silent merge or ongoing dual-write with an existing personal Memory MCP installation.

## What “complete conversation” includes

Ingestion reads canonical saved records, **not the model's compacted context and not a model-made
summary**. It captures persisted user/assistant text and record metadata, recorded tool arguments
and outputs, complete archived tool results, and UTF-8 text attachments. Small newly acquired
tool results are explicitly recorded before replay, so future file reads are not just filenames.
Referenced archived outputs are resolved rather than ingesting only their first preview page.

Binary attachments remain in the original workspace store. Their metadata is captured, but their
binary payload is not base64-disguised as text and no OCR is invented. Runtime secrets, model-only
encrypted reasoning, and outputs that an older version never persisted are not reconstructed.
Transient streams that never reached the canonical commit barrier are not successful saved turns.
This mode does not repair historical data that was already discarded by older implementations.

The first enrolled message of an existing chat starts from canonical sequence zero, including
messages older than compaction. Enrollment occurs when the owner creates a chat or next sends a
message to an existing one. Inactive old workspaces are **not** bulk-imported in the background.

## No silent clipping

The native service accepts at most 500 messages per ingest and 32,768 UTF-8 bytes per content.
The adapter reads at most 4 KiB archive-page envelopes, frames their content as valid JSON, and
checks the resulting message's actual UTF-8 size. Up to eight pages (possibly consecutive chat
records) form one batch. Larger originals continue through subsequent batches until EOF.
Combining the envelope `content` fields in offset order reproduces the archived original exactly;
parse an original JSON record only after all its fragments have been combined.

Hash/cursor verification remains in the existing archive reader. Malformed Unicode, missing
sources, denied access and failed durable writes stop progress visibly; they do not become empty
successes or cause later records to jump over the problem. No queue TTL or retry-count deletion is
added. The workspace still owns the complete source independently of Agent Memory's extraction.
Recall queries over 1,024 UTF-8 bytes are rejected rather than shortened.

## Delivery, recovery and visibility

The canonical sequence increment records the pending high-water mark. New owner conversations
and queue enrollment share their existing storage transaction. The existing unified DO alarm
selects memory work alongside agent/callback work; a separate component does not overwrite the
alarm. Idle delay is 30 seconds; continuing activity targets a five-minute checkpoint, and
compaction can make work due sooner. Alarm scheduling is best effort, not a real-time guarantee.

Before remote I/O, the queue stores the exact immutable batch and continuation. Only successful
`ingest()` followed by a successful local ACK advances the cursor. Restarts, throttles, timeouts,
late successful responses, and local ACK failures retry identical messages with the same session.
This is at-least-once delivery backed by the service's documented content/session idempotency,
not a distributed exactly-once transaction. Retries back off from 30 seconds up to one hour;
new messages cannot erase a failed batch or its backoff. Current source authorization is checked
again before transmission. A namespace/owner change fails closed instead of moving a backlog.

A chat deletion cancels its local queue and archives without resurrecting them when an old I/O
call resolves. It does **not** imply deletion of previously accepted Agent Memory data. An already
submitted remote call cannot be recalled. Remote session/profile deletion is a separate explicit
operation and is not automatically issued by this change.

Two native tools are available in enrolled owner chats:

- `searchBotMemory(query)` searches the server-selected bot profile, never a model-supplied user ID.
- `memorySyncStatus()` reports pending/retrying/caught-up, acknowledged sequence, high-water mark,
  next due time and last acceptance. `caught-up` means API acceptance, **not** completed indexing.

The bot editor displays a native-mode disclosure. Its existing “automatic recall off” preference
controls proactive search, not automatic capture. Full capture is the deployment-level opt-in.
The native prompt instructs the agent not to upload transcripts again through connected MCP;
existing connector grants are not revoked. Memory output is remembered evidence, not a system
instruction or a new permission. Disabling native configuration
pauses the integration without deleting pending state or changing existing provider credentials.

## Verification and limits of this change

Focused Node tests cover the actual transport/state machine and host adapter with synthetic
storage/API fixtures, UTF-8/JSON round trips, restart/retry stability, concurrent append, deletion,
local ACK failure, revocation, namespace configuration and API provisioning. Strict TypeScript
checks cover the dependency-free transport and host modules. The changed original wrapper files
were reconstructed and checked against their Git blob SHA before editing.

Native Workerd/typed-storage/archive and frontend disclosure regression tests are included in
`build.mjs --check`. They must be run in the repository's normal dependency-equipped environment.
The implementation session could not clone upstream or install dependencies because runtime
network access was unavailable, so a full reconstructed build, real Agent Memory integration,
and live deployment were **not** verified. Local patch anchor checks are mechanical checks, not
substitutes for the full native gate. No production installation is enabled by publishing this code.

## Official references reviewed

- Workers API, lazy profile provisioning, ingest/recall types and limits:
  https://developers.cloudflare.com/agent-memory/api/workers-api/
- Namespace HTTP management and status codes:
  https://developers.cloudflare.com/agent-memory/api/http-api/
- Namespace/profile/session isolation:
  https://developers.cloudflare.com/agent-memory/concepts/namespaces-profiles/
- Checkpoint/idle ingestion guidance:
  https://developers.cloudflare.com/agent-memory/get-started/
- Verbatim submitted messages and content/session idempotency:
  https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/
