# Personal Notion MCP Events

Build a separately deployed personal Worker in this monorepo. Reuse the existing Channel Talk server's generic OAuth consent, byte handling, callback validation and Standard Webhooks signing code. Keep its deployment, grants, namespaces, source configuration and optional Assistant forwarding unchanged.

Deployment, new credentials, resource creation, live subscriptions and data backfill are outside this source change. Main integration requires checking deployment coupling; retain every branch reference.

## Decisions

- One `apps/notion-events` Worker, its own OAuth KV and owner SQLite Durable Object. No OS inference, chat, memory or Channel Talk service binding is required.
- Advertise MCP `2026-07-28`, authenticated discovery, tools and webhook events on `/mcp`. Use the existing owner consent flow with a separate `notion:events` scope.
- Receive `notion.comment.created` and `notion.comment.updated` with distinct subscription filters. Signed Notion workspace, integration, subscription and exact page allowlists gate persistence. Person events and all updates remain eligible regardless of configured author IDs. Known non-person bot creation filters are source selection only. Never infer human/companion identity from author, name, creator or `by-you`, and never write a Notion reply.
- Persist original signed body bytes before acknowledgment, deduplicate on source event ID and reject conflicting replays. Fetch the comment through the fixed Notion API endpoint after acknowledgment. Preserve full enrichment separately; source timestamps and observation time remain distinct.
- Store subscriptions, capture jobs, callback jobs and terminal failures durably. Bounded transient retries end in a retained dead-letter record, never silent deletion. All failures remain inspectable through bounded pagination. Subscription expiry, revocation and unsubscribe stop delivery but preserve archives and delivery disposition. Callback 410 stops that delivery, without deleting the subscription.
- Deliver metadata-only notifications with unknown attribution and automatic response disabled. Authenticated byte/Unicode-safe archive pagination recovers all original and enriched content. Never trim the archive to fit a response. Exact owner-reported write receipts are diagnostic only and never suppress notifications or mutate queued bodies. Automatic responder activation remains blocked until the actual writer enforces a pre-write receipt barrier; see [the provenance contract](../../../apps/notion-events/PROVENANCE.md).
- Validate callback HTTPS, trusted OpenAI hostname boundaries, credentials, ports and fragments; disallow redirects. Validate public DNS answers before each callback attempt. Keep DNS/fetch platform limitations explicit in verification notes.

## Alternatives

Embedding Events in the OS Workshop runtime couples subscriptions to inference and OS releases. Extending the existing Channel Talk deployment couples personal Notion data to another installation's grants and state. A separate repository duplicates maintenance. A dedicated Worker in this repo preserves the existing protocol investment and provides a small independent boundary.

## Validation and limits

Use synthetic signatures, OAuth grants, Notion responses and callback receivers in Miniflare. Test page and owner boundaries, self authors, replay conflicts, full Unicode archives, failures, restart durability, grant revocation, subscription races and callback signing. Run existing Channel Talk regression checks after extraction. Run wrapper and full OS checks before integration. Live Notion access, callback delivery and indexing are not inferred from local tests.

References: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [Notion delivery](https://developers.notion.com/reference/webhooks-events-delivery), [retrieve comment](https://developers.notion.com/reference/retrieve-comment).
