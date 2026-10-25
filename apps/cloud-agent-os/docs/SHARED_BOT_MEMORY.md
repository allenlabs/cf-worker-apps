# Shared memory and main bot

This extends native Cloudflare Agent Memory in `feat/bdots-bot-workspaces` without
changing the pinned OS runtime. The documented API isolates profiles and has no
arbitrary tags or multi-profile recall field. The OS selects authorized profiles
and combines their recall responses with source attribution.

## Memory routing

- **Bot conversation:** capture each canonical text record once into its stable
  owner-plus-bot-UUID profile. Renames, edits and main-bot changes preserve this key.
- **Common owner context:** reuse the existing Standard assistant (`botId: null`)
  profile. Start a Standard assistant conversation for context that every bot may
  recall. Its original profile and historical memory remain available.
- **Default recall:** current bot plus common owner context. Standard assistant
  searches the common profile once. Other bot transcripts remain in their own profiles.
- **Selected recall:** add specified bot UUIDs from the authenticated owner's catalog,
  including archived bots with retained history.
- **All recall:** search all catalogued owner bot profiles plus common once. Reject
  more than 64 distinct profiles explicitly; never silently omit a source.

This choice avoids copying every bot transcript into common memory, which would
both double ingestion and allow default recall to bypass the selected/all choice.
The editor explains that Standard assistant conversations provide common context.

`listBotMemorySources()` returns authorized bot IDs and names. The agent can use
`searchBotMemory({query, scope:'selected', botIds:[...]})` or `scope:'all'`.
The server derives profile names from the verified owner and catalog UUIDs, never
from model-supplied owner/profile names. At most four profile recalls run together.
A source failure produces `complete:false` and a source-specific error while
retaining successful results. Each lookup has a combined 90-second bound. A timed-out
uncancellable request retains its concurrency slot; sources that cannot be started
receive explicit errors rather than exceeding four in-flight calls or hanging recall. Each result identifies its source kind, bot UUID,
label and candidate memory/session IDs. Scores are not globally reranked.

Semantic recall is a derived view, not an exhaustive transcript export or proof
of finished indexing. Canonical original text remains in the workspace DO archive;
raw retrieval and page integrity remain independently available.

## Delivery and legacy state

The original per-bot queue keeps its frozen messages, timestamps, stable session
ID, source authorization checks, retry backoff and acknowledged cursor. Each page
is sent once per destination; ambiguous responses may replay the identical batch
using the service's documented ingest idempotency. No message is truncated and
no automatic backfill to a second profile is scheduled.

The earlier branch implementation automatically copied all bot transcripts into
separate `common-*` profiles. Existing `commonPosition` and `commonPending` data
are retained unchanged, but no longer transmitted. `memorySyncStatus()` exposes
`commonSharing:'paused'`, the retained cursor and backlog when this legacy state
exists. `caught-up` describes the active per-bot destination only; it does not
claim that paused legacy sharing completed. Already accepted legacy profiles are
not deleted, renamed, migrated or searched by default. Any migration requires a
separately authorized operation. This code does not run real-data migration.

## Main bot

The authenticated account owns at most one optional main-bot pointer in its User
DO. Revision checks reject stale changes. Unknown/archived bots cannot become main;
archiving main clears the pointer without modifying historical snapshots or memory.

Home and workspace new-chat drafts use main after the owner's catalog loads.
An explicit deep-link selection takes precedence; selecting Standard assistant
bypasses main for that draft. After accepted chat creation, the next draft returns
to main. API/account changes clear local selections, and delayed responses from
an old account cannot replace the current main setting. Existing chats retain
immutable bot snapshots.

## Verification

Verified on 2026-10-25 with Node 24.19.0 and pnpm 11.19.0 against pinned upstream
`4358072f8cb1bc9ddfb6ee11122e194c76cd71e0`:

- Wrapper `npm test`, with optional compiler, Text asset and Wrangler fixtures enabled:
  **132 passed, zero failed or skipped**. `npm run typecheck` also passed.
- Full `node scripts/build.mjs --config <synthetic-native-oidc-mcp.json> --check`:
  **exit 0**. All applicable package/browser TypeScript checks and frontend bundles
  passed; native backend **765 tests / 42 files**, frontend **507 / 33**, and MCP
  **35 / 1** passed. Native OIDC/OAuth JWT login and handoff checks also passed.
- All **five Worker dry-runs** passed, including the native `OS_AGENT_MEMORY`
  binding and frontend assets. No namespace provisioning runs in check mode.
- Targeted lint passed for all **14 changed TypeScript files**. Full upstream
  `pnpm run lint:check` still fails with **127 existing errors in 27 files**.
  Comparison with base `8724334` confirmed every remaining error line pre-existed
  this continuation; 19 bot/memory lint errors were removed and none introduced.
- Independent code review and `git diff --check` passed. The app has no configured
  coverage script; these results do not claim a coverage threshold.

Tests use synthetic identities/configuration and local temporary storage. A live
Agent Memory connection, service indexing, production deployment, resource creation
and real-data ingestion/backfill were not run. The checks establish local runtime,
RPC schema, archive/outbox and UI integration, not live service availability.

## Official Cloudflare references

- [Workers API](https://developers.cloudflare.com/agent-memory/api/workers-api/)
- [Namespaces, profiles and session isolation](https://developers.cloudflare.com/agent-memory/concepts/namespaces-profiles/)
- [Ingest idempotency](https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/#idempotency-and-deduplication)
- [Limits](https://developers.cloudflare.com/agent-memory/platform/limits/)
