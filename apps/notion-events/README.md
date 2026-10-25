# Personal Notion MCP Events

An independently deployed personal Worker that forwards new comments from explicitly selected Notion pages to authenticated OpenAI MCP Events subscriptions. It shares reviewed protocol and OAuth consent code with `apps/mcp-events`, but has its own hostname, OAuth grants, KV and SQLite Durable Object namespace. It does not bind the existing Channel Talk deployment or the Cloudflare OS runtime.

## Contract

Connect `/mcp` through OAuth with `notion:events`. Discovery advertises MCP `2026-07-28`, tools and webhook events. Subscribe to `notion.comment.created` with `{ "page_id": "55555555-5555-4555-8555-555555555555" }`, a webhook delivery and signing secret. Only exact configured pages are available; child pages are not implicitly included. Subscriptions last at most seven days and survive restarts for their granted lifetime. Refresh before `refreshBefore`. There is no historical replay or backfill.

Notion sends signed events to `POST /webhooks/notion`. Raw-body HMAC, workspace, integration, subscription, exact page and configured bot-author checks run before persistence. The original signed UTF-8 bytes persist before `202 Accepted`. Notion retries may change `attempt_number`; these retain additional exact receipts without repeating enrichment or callback delivery. A conflicting event ID with different normalized source identity receives `409`.

The Worker later retrieves the comment through the fixed Notion API endpoint using `Notion-Version: 2026-03-11`. It validates the returned comment ID, parent and optional discussion identity. It preserves full rich-text JSON, all plain text, source provenance and observation time. A comment may have changed between its creation event and retrieval; the archive is the observed API snapshot, not a claimed historical snapshot. The relay never writes a Notion comment. Both signed webhook authors and the retrieved creator exclude the configured bot user.

## Archives and failures

- `integration_status` reports capture/delivery counts and the newest ten failure identifiers from each queue, without text, callback URLs or secrets. `list_failures({kind:"capture"|"delivery",cursor?,limit?})` pages through all retained failures, including those whose subscriptions have ended.
- `read_event_archive` accepts `{ "event_id": "evt_<source-uuid>", "part": "source", "cursor": "0", "limit": 32768 }`. Use `part: "comment"` for the full enriched JSON. Concatenate `text` pages and follow `next_cursor` until `null`. Cursors are byte offsets at UTF-8 boundaries. `limit` is an upper bound; wrapper encoding can require a smaller page.
- Source reads return `receipt_digests`. Pass a digest in optional `receipt` to read that exact later Notion delivery. The default is the first original receipt.
- Transient capture and callback failures retry at most eight times, honoring available `Retry-After`. Terminal failures remain durable. `retry_failed({kind:"capture"|"delivery",id})` explicitly restarts a retained failure. Revoked, expired or unsubscribed access is not restored. Manual callback retry may repeat an already accepted event if its response was lost.
- There is no automatic archive, receipt, sent-delivery or dead-letter deletion. Monitor storage and plan an explicit archive/export retention policy before sustained use. There are at most 100 active subscriptions, 100 distinct receipts per source event and 10000 pending capture/delivery jobs. Capacity failures return `503` before acknowledging new data. Request bodies above 1 MiB and comment API responses above 8 MiB fail explicitly; an oversized comment remains unhydrated with its original event retained for recovery. The code never accepts a shortened comment as complete.

Each callback body is at most 256 KiB. Complete text is delivered when it fits. Otherwise `text_in_archive:true` and `archive_id` refer to the authenticated complete archive. Source metadata too large for an event also stays in that archive. Event IDs and body bytes remain stable across retries; signatures use a fresh timestamp. An acceptance response is transport acceptance, not proof that a ChatGPT task ran.

Unsubscribe, expiration, changed page scope and grant revocation stop pending deliveries with a retained disposition. `410`, `413`, redirects and other permanent callback failures stop that delivery and retain its failure; `410` does not delete the subscription. An already transmitted request can finish after unsubscribe. OAuth grant revocation is subject to the provider KV's propagation behavior.

## Private configuration and activation

The checked-in Wrangler file contains synthetic examples only. Supply a separate personal Worker name, stable public HTTPS origin, custom domain, OAuth KV and SQLite namespace in private deployment configuration. Do not reuse another installation's secrets, namespaces, OAuth owner identity or subscriptions. No production state migration is required.

Required nonsecret settings are `PUBLIC_ORIGIN`, `EVENTS_OBJECT_NAME`, `OAUTH_OWNER_ID`, `NOTION_WORKSPACE_ID`, `NOTION_INTEGRATION_ID`, `NOTION_SUBSCRIPTION_ID`, `NOTION_BOT_USER_ID` and JSON array `NOTION_PAGE_IDS`. Required private bindings are `OWNER_LOGIN_KEY` (32–256 characters), `NOTION_API_TOKEN` and `NOTION_VERIFICATION_TOKEN`. The token needs page access and Notion's **Read comments** capability. The bot user ID is the top-level ID returned by `/v1/users/me`, not the integration ID. Configuration fails closed; health exposes only configured status.

Optional `NOTION_IGNORED_AUTHOR_IDS` is a JSON array of additional writer UUIDs to exclude in both signed authors and retrieved creators. Before enabling an automation that writes comments through a different Notion integration, add that writer's bot ID here. The source token's own bot ID alone cannot identify a different integration's writer. Other bots and agents remain available as event sources unless explicitly excluded. Ignored authors are also rechecked before queued callback delivery.

Initial Notion verification is a separate operator step. Notion first sends an unsigned `verification_token`; this Worker acknowledges only a token already configured privately and never echoes or logs it. For a fresh installation, use an operator-authenticated temporary receiver at the **same final webhook hostname and path** to retrieve the initial token, configure the private binding, replace that receiver with this Worker, and complete verification in Notion's UI while the subscription is pending. Do not change the verified URL: Notion requires subscription recreation when that URL changes. Do not expose the temporary receiver's token retrieval to anonymous callers or activate it without separate approval. No bootstrap receiver, connection, credential generation or real subscription was activated by this implementation.

Callbacks require HTTPS on `chatgpt.com`, `openai.com` or their subdomains, without user info, fragments or nonstandard ports. Every attempt checks public A/AAAA answers and refuses redirects. DNS lookup and Worker fetch are separate operations: the Worker API does not pin the validated address to the subsequent connection. This code therefore does not claim complete DNS rebinding protection. Keep the trusted-host boundary; supporting arbitrary callback hosts requires a reviewed egress mechanism that enforces the connection address.

## Local verification

Run `npm run -w @cf-worker-apps/notion-events test`, `typecheck` and `build`. All runtime tests use synthetic source data, OAuth grants, DNS answers and callback receivers in Miniflare. `test:coverage` requests actual workerd coverage and exits nonzero when the runtime profiler is unavailable; Node harness coverage is not Worker coverage. This app has JavaScript syntax checks rather than a TypeScript compiler or a configured coverage threshold.

No live Notion access, callback delivery, production resource provisioning or deployment follows from local tests. Real activation remains a separately approved operation.

See [the verification record](VERIFICATION.md) for observed results and remaining limits.

References: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [Notion webhooks](https://developers.notion.com/reference/webhooks), [comment created](https://developers.notion.com/reference/webhooks/comment-created), [retrieve comment](https://developers.notion.com/reference/retrieve-comment), [request limits](https://developers.notion.com/reference/request-limits), [design and plan](../../docs/superpowers/specs/2026-10-25-personal-notion-events.md).
