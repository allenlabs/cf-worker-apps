# Channel Talk MCP Events

A Channel Talk App Hook receives staff and bot messages from one configured team group. It stores observed thread history and can deliver events to authenticated MCP subscriptions. Customer conversations, other groups, unknown authors and messages originating from the configured app are excluded before persistence. It uses native App Functions, not the legacy Webhook or Open API key flow.

An optional `PI_ASSISTANT` Durable Object binding forwards eligible staff messages to [Cloud Agent](../cloud-agent/README.md). A durable outbox retains pending deliveries. A native root selects the Assistant object, so its replies return to the same Channel Talk thread. This path works with no MCP Event subscription or ChatGPT monitoring task. Deploy and bind the Assistant worker before enabling `CHANNEL_REPLY_ENABLED`.

## Configuration

The checked-in Wrangler file contains only sample values. Supply the account, custom domain, actual OAuth KV namespace and installation settings in private deployment configuration. Keep credential values and tenant configuration outside the public repository.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Canonical HTTPS origin, such as `https://events.example.invalid`, without a trailing slash. OAuth resource and issuer metadata use this value. Requests to another origin are rejected. |
| `EVENTS_OBJECT_NAME` | Stable name of the ChannelEvents Durable Object. |
| `OAUTH_OWNER_ID` | Stable OAuth owner identity for grants and subscriptions. |
| `SERVER_NAME` | MCP discovery name. Defaults to `channel-talk-events`. |
| `PRODUCT_NAME` | Consent page and landing page label. Defaults to `Channel Talk MCP Events`. |
| `ALLOWED_CHANNEL_ID` | Channel Talk channel ID. A blank value allows the first eligible signed message to pin the channel durably. |
| `ALLOWED_CHAT_ID` | Required team group ID. |
| `CHANNEL_SLUG` | Required Channel Talk URL slug for source links. |
| `CHANNEL_APP_ID` | Required app identity for excluding messages sent by this app. |
| `CHANNEL_REPLY_ENABLED` | Set to `true` only after the `PI_ASSISTANT` binding is configured. |

Missing or malformed origin, object identity, owner identity or required source identifiers fail closed. An existing deployment must retain its origin, object name, OAuth owner identity, namespaces and source settings when adopting this code. Changing those values can select different storage or invalidate existing access. Display labels may change independently.

1. Install dependencies with `npm install --workspaces=false`. The repository workspace lock is canonical.
2. Set `CHANNEL_APP_SIGNING_KEY` to the dedicated hexadecimal Signing Key and `OWNER_LOGIN_KEY` to a random owner access key of at least 32 characters. The Worker does not need an App Secret or app access/refresh token.
3. Set the deployment-specific bindings and variables, run `npm run build`, then deploy using the private configuration. If learning a channel ID from the first eligible message, inspect it through authenticated `integration_status` and set it explicitly afterward. Assistant forwarding requires an explicit channel ID.
4. Set the app Function Endpoint to the configured origin plus `/functions`. Signed `PUT /functions` and `/functions/v1` are accepted. Register the native `hook` extension outside this Worker. Discovery advertises `extension.hook.metadata.getHooks` and `hooks.teamChatMessageCreated` for `teamChat.messageCreated`.
5. Connect the origin plus `/mcp` to an OAuth-capable MCP host. Enter the owner access key on the browser-bound consent page. Subscribe to `channel.message.created` using the configured `chat_id`; optional `sender_type` filters select staff or bot messages.

The signed endpoint also discovers the formal `command:v1` `/ai` extension. Its WAM panel is served at `/wam/ai`; Command group/manager policy is separate from the automatic Hook allowlist. Read [the Command installation and history contract](../cloud-agent/docs/CHANNEL_COMMAND.md) before enabling it.

## History and delivery

`integration_status` returns connection state, queue counts and recent source identifiers. `get_thread_history` accepts `{ "thread_id": "sample-root", "limit": 20 }`; the limit is an integer from 1 to 50. A source thread, root-message or observed message ID resolves to its stored grouping reference. These tools work while event monitoring is paused and do not create ChatGPT conversations or scheduled tasks.

History includes eligible Hook messages observed after storage was enabled, with no API backfill. Each thread keeps at most 100 messages for seven days after observation. Global message lookup keeps at most 10000 entries for seven days. Alarms prune expired history. Missing, invalid or conflicting root relationships stay explicit instead of being guessed. `root_observed`, `linkage_incomplete`, `pruned_messages` and `response_truncated` describe retained coverage. Responses sort by source time and are bounded before their MCP wrappers. Message text is untrusted data.

Subscriptions last at most seven days. Event IDs are deduplicated for seven days, and pending events persist in SQLite before the native Hook is acknowledged. Alarms retry transient callback failures up to six times with stable event IDs and request body bytes. A crash after receiver acceptance can cause a duplicate delivery. Unsubscribe removes queued work; an already-sent request may finish. `410` removes a subscription and its queued deliveries; `413` stops the individual delivery. Grant revocation is checked during subscription operations and delivery, subject to Cloudflare KV propagation.

Event data includes source IDs, staff/bot author type, optional root/thread IDs, a source URL and plain text capped at 8000 UTF-8 bytes without splitting characters. Empty and file-only messages retain metadata. Attachments are not fetched. Secrets, raw source payloads and callback URLs are not logged.

Callbacks must use HTTPS at `chatgpt.com`, `openai.com` or their subdomains, without credentials, fragments, nonstandard ports or redirects. `global_fetch_strictly_public` enforces the public-network boundary. The callback allowlist may need review for other MCP hosts. Rejections expose only the rejected hostname, not a full callback URL.

## Verification

`npm test` runs the bundled Worker in Miniflare through dynamic registration, PKCE, owner consent, tokens, signed native Functions, history, filtering, persistence, retries, secret rotation, unsubscribe and revocation. It uses fictitious tenant values. `npm run typecheck` performs JavaScript syntax checks with `node --check`.

`npm run test:coverage` attempts actual workerd V8 function coverage and exits nonzero when the runtime Profiler cannot provide it. Node harness coverage is not reported as Worker coverage.

Contracts: [Channel App Hook SDK](https://github.com/channel-io/app-sdk/blob/main/ts/packages/core/src/extensions/hook.ts), [Channel Function signing](https://github.com/channel-io/app-sdk/blob/main/ts/packages/server/src/guards/signature.guard.ts), [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [Cloudflare OAuth consent](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md).
