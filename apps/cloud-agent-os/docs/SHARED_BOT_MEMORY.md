# Shared memory and main bot

This feature builds on native Cloudflare Agent Memory support in `feat/bdots-bot-workspaces`.
The Cloudflare API has namespace/profile/session scopes; it does **not** expose arbitrary
metadata filtering across profiles. The OS owns the source catalog and joins recall results
server-side. No new Cloudflare credential or cross-account grants are introduced.

## Memory routing

- **Private bot**: every new canonical text record is ingested into the bot's stable per-UUID
  profile (existing route). Standard-assistant chats use their existing separate null-bot profile.
- **Common**: the same original text is independently ingested into an owner-wide common profile.
  It is not a derived summary or an undocumented API `tags` property.
- **Default lookup**: search the current bot (or Standard assistant) and common memory.
- **Selected lookup**: default plus named other bots selected by UUID from the authenticated
  owner's catalog. Archived bots can still supply historical memory.
- **All lookup**: current bot, common memory, every bot profile and Standard assistant.
  The operation rejects more than 64 distinct profiles rather than silently dropping results.

The bot tool `listBotMemorySources()` returns the allowed bot IDs and names; then
`searchBotMemory({query, scope:'selected', botIds:[...]})` or
`searchBotMemory({query, scope:'all'})` expands the lookup.
The server resolves profile names using a verified owner, never the model's free-form
profile name. Search uses up to four simultaneous profile recalls. A failed profile is
marked as an error with `complete:false`; successful profiles remain present, with
their originating bot IDs, labels, session IDs and candidate memory IDs.

**Canonical original source** is still in the workspace DO text archive. Agent Memory is
derived memory, and `recall` does not guarantee original full transcript text.
Raw retrieval and page integrity remain separate from semantic recall.

## Common ingest and migrations

The common name is `common-` plus SHA-256 of a versioned tuple with verified owner.
It remains stable when the main bot or individual bot names change.
Each conversation sends to two independent destinations, with distinct durable
`position/pending` and `commonPosition/commonPending` cursors. The same frozen
message timestamp, content fragments and session ID are used in retries.
Both destinations must be acknowledged to report caught-up; an error cannot advance
an unsent cursor.

On enrolling a previously existing private-only chat, the private cursor is retained
and the common cursor starts at canonical sequence zero for a lossless backfill.
Previously unused chats are not globally scanned. Deleting a chat prevents local
retries but does not automatically delete already accepted Agent Memory data.
Doubling full-text ingest increases service work and may increase billing when
the Cloudflare private beta pricing changes.

## Main bot

An account owns **at most one** optional main-bot pointer, persisted in the User
Durable Object collection `mainBot` with a revision. Setting/clearing it uses
optimistic concurrency and owner authorization. Archived or unknown bots cannot
become main; archiving the current main clears only the pointer, not the bot's
historical snapshots or memory.

New conversations choose the main bot by default on the home page and inside
workspaces, subject to loading the authenticated account's selection.
An explicit deep-linked bot takes precedence. A deliberate selection of
`Standard assistant` bypasses main-bot auto-selection for that draft.
Changing main never rewrites an existing chat's fixed bot configuration.

## Verification

Pure main-bot and memory-scope tests were executed separately with Node 22's
TypeScript stripping, 12/12 passed. Native Worker queue, profile fanout and
frontend picker regression tests are included in the wrapper's normal build
gate; full Workerd integration requires running `build.mjs --check` from
a dependency-equipped environment. No production deployment is implied.

## Official Cloudflare references

- https://developers.cloudflare.com/agent-memory/api/workers-api/
- https://developers.cloudflare.com/agent-memory/concepts/namespaces-profiles/
- https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/
