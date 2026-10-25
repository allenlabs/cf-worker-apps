# Bot workspaces and recoverable context

## Scope

This branch adapts named roles, a bot library, conversation entry points, and repeated-tool-call
protection from [bdots](https://github.com/fayazara/bdots/tree/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b).
The existing OpenCode Workerd loop, provider selection, scoped resources, and authorization remain
the execution substrate. The upstream pin does not change.

The user explicitly requested a feature branch. This takes precedence over the repository's usual
main-only workflow. This change does not authorize a production deployment or a merge.

## Design

- Personal bot profiles are durable records in the authenticated user's existing Durable Object.
  A profile has a name, role, instructions, icon, conversation starters, and a memory preference.
  It contains no credentials or capability grants.
- Creating a chat resolves the selected bot and exact revision through that user's DO. The chat
  stores an immutable configuration snapshot. Editing or archiving a profile cannot rewrite a
  previous conversation, including a turn resumed after a Worker restart.
- A bot is a reusable role, not a separate security principal or an isolated memory database.
  Shared workspaces retain their existing access rules. Instructions copied into a chat can be
  read by that workspace's collaborators. Model and provider choices remain explicit.
- Connected memory uses the current user's authorized MCP connection. It is optional guidance
  to recall and save reusable facts, not a second memory store or a guaranteed background ingest
  job. Cloudflare Agent Memory can sit behind that MCP endpoint. Credentials and profile mapping
  stay with the existing connector. No shared personal token or installation address is bundled.
- Limits reject invalid or oversized input visibly. They never silently shorten saved profile
  text, remove old messages, or pass an incomplete network response off as a complete result.
- Compaction is a derived handoff. Canonical messages stay available, incomplete summaries cannot
  advance the checkpoint, and the agent can retrieve original messages through explicit pages.
- Large acquired tool text is archived before a bounded page is returned. Every page identifies
  its artifact, offset, continuation and completion state. Archive storage has no automatic expiry.
- Exact consecutive repeated tool calls stop before another effect, after the existing durable
  step barrier. The transcript preserves the paired error result and every preceding result.

## Using a bot

1. Open **Bots** in the main sidebar and choose **Create a bot**. Set its name, job and
   instructions; optionally choose an icon and up to six conversation starters.
2. Save, then use the bot card to start a conversation. The home page also offers a bot selector.
   Pick the provider and model explicitly. Choosing a bot does not silently change either.
3. A starter fills an empty composer. If a draft already exists, the full proposed starter is
   shown separately so it cannot overwrite the draft. Loading, discovery errors, and an empty
   bot library have separate states.
4. Edit or duplicate a profile for future chats. Optimistic revisions reject stale saves and
   stale chat selections. A failed save keeps the complete editor draft for review or copying.
   Archive hides the bot from new-chat selection; restore makes it available again. Neither
   operation deletes existing chats or their stored profile snapshots.

## Memory semantics

**Use connected memory** adds instructions to use the current user's authorized memory tools for
relevant recall and concise, permitted checkpoint facts. Cloudflare Agent Memory is compatible
with this through the existing MCP connector. There is no new runtime, shared memory token,
bot-specific namespace, or background ingestion service in this branch.

**Automatic recall off** asks the bot not to use external memory unless the user explicitly requests
it. This is a conversation preference, not a capability revocation; tools and connection grants
remain managed through **Connections**. The bot editor links there and to **Providers**.

Memory is an optional derived store. Canonical chat messages and acquired tool text stay in the
workspace's own storage. A memory save is successful only after its tool returns successfully.
This branch does not claim that selecting the setting provisions an Agent Memory account or
uploads complete transcripts automatically.

## Limits and preservation behavior

| Boundary | Current bound | Behavior |
| --- | --- | --- |
| Bot profile text | Name 80, description 320, instructions 16,000, each starter 2,000 UTF-16 code units; six starters | Reject an invalid or oversized save; do not shorten the saved text or the editor draft. Unicode must be well-formed. |
| Model-facing large text | Archive when the acquired text exceeds 32 KiB UTF-8 | Save the complete text first, then return a bounded, explicit page. Applies to large file windows, grep, web results, and code output. |
| Archive pages | At most 8 KiB for the entire serialized JSON envelope | Preserve Unicode scalar boundaries; include artifact/hash, offsets, next cursor, and EOF. Concatenate content before parsing an original JSON document. |
| Storage chunks | At most 32 KiB of raw UTF-8 and serialized JSON text | Hash each chunk; commit content, manifest, and access provenance atomically. Reject missing or corrupt data. |
| Web acquisition | Default 1 MiB; configurable up to 5 MiB | Fail and cancel on overflow instead of reporting a prefix as the complete document. Reject malformed UTF-8 in text passthrough; preserve a valid BOM. |
| Code output | 4 MiB of accepted log/return text per execution | Capture complete events inside the loaded Worker and return via RPC. An over-limit event is rejected before acceptance; prior accepted output and an explicit error remain available. |
| Repeated calls | Five consecutive identical tool/name + canonical arguments; sixth blocked | Preserve preceding results and paired errors through the durable turn barrier; stop before another tool effect. |
| Compaction | Existing model/context budgets remain | Require successful stream EOF and normal stop before advancing the checkpoint. A summary is derived context; original records remain retrievable. |

The code-output collector snapshots arguments at call time, captures module initialization and the
return value, and waits for registered `ctx.waitUntil()` tasks, including nested tasks. Platform
Tail logs are presentation data, not the canonical result; their independent log cap cannot shorten
stored output. A loaded worker returns the same capture if its run RPC is called again, without
re-executing effects. An isolate crash or transport failure before the capture returns is reported
as an incomplete execution, with no automatic retry and no claim that all output was recovered.
Unregistered background work is not a completion boundary; executed code must await its work or
register it with `ctx.waitUntil()`.

`readChatHistory` retrieves canonical records even before a compaction checkpoint. `readStoredText`
continues an archived result. Current resource grants are rechecked for protected history and for
pages recovered through other pages; revocation blocks access without deleting originals. File
read bookkeeping and reverted-result elision keep their existing replay semantics.

There is no automatic archive expiry or message-count deletion in this branch. Explicit chat
removal also removes its text archives. Durable Object capacity and platform execution limits
still exist: a failed acquisition, failed durable write, or hard runtime termination is not a
successful complete record. Document conversion is the existing content extraction step; this
archive preserves the acquired tool text, not a byte-for-byte binary copy of every fetched file.

## Implementation and verification

New modules, components, and regression tests live in `overlay/`; changes to pinned upstream files
live in ordered patches. The application remains reconstructible from the same upstream pin and
these wrapper inputs. No bdots runtime package or deployment is added.

From `apps/cloud-agent-os`, run:

```sh
npm test
npm run typecheck
node scripts/build.mjs --check --config deployment.example.json
```

The check builds the native frontend and Workers, runs the wrapper's native backend/frontend
gates (including bot profiles, snapshots, replay, archives, complete output, compaction, and loop
guards), and performs Wrangler dry runs using synthetic configuration. Backend test files execute
serially because each native Worker test pool loads the backend. This changes resource use, not
assertions or test selection. It does not deploy or modify an installation.

Regression tests exercise real Durable Objects, the actual `runAgent` loop with scripted models,
and native WorkerLoader output capture. They cover restart/isolation, stale revisions, full Unicode
round trips, authorization revocation, original history after compaction, late stream failure,
read-before-edit state after replay, reverted reads, code output beyond the platform log cap, and
the full accepted 4 MiB RPC boundary. Frontend tests cover create/edit/archive/restore, login return
paths, preserved drafts and pending starters, existing chat identity, and explicit model selection.

## Deliberate exclusions

The branch does not transplant bdots' Think runtime, text-slicing guards, browser recorder,
credential store, automatic deletion of quiet routine messages, or separate deployment topology.
Scheduled routines and browser teaching need their own capability and consent UX. They are not
shown as enabled features here.

## References

- [bdots identity and job editor](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/src/components/settings-panel.tsx)
- [bdots guards](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/src/agents/guards.ts)
- [Grok Bot creation](https://docs.x.ai/grok-bot/bots)
- [Grok Bot settings](https://docs.x.ai/grok-bot/settings-and-notifications)
- [Cloudflare Agent Memory](https://developers.cloudflare.com/agent-memory/)

The Job editor follows bdots. Grok's documented personal Bots update their job in chat; its
role-centric creation and profile navigation are design references, not a compatibility claim.

## Attribution

The bot identity/library/job patterns and consecutive-call guard idea are informed by Fayaz Ahmed's
[bdots, MIT license](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/LICENSE).
The adapted implementation is written for this project's existing storage, UI, authorization, and
OpenCode loop; no bdots source files or assets are vendored. Grok Bot is a product design reference.

- [Cloudflare Workers log limits](https://developers.cloudflare.com/workers/platform/limits/#log-size)
- [Cloudflare console behavior](https://developers.cloudflare.com/workers/runtime-apis/console/)
- [Agent Memory integration and checkpoint ingestion guidance](https://developers.cloudflare.com/agent-memory/get-started/)
