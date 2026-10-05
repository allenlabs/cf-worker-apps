# Management workspace

The management page opens a conversation workspace. Section navigation selects Conversations, GitHub, Skills, Accounts, and Activity. The conversation list supports local search and sorts observed roots by last activity. Selecting a root opens its transcript; a native disclosure holds model, thinking, and session controls.

`PRODUCT_NAME` names the product. `TENANT_NAME` supplies the visible workspace subtitle and defaults to `Workspace`. Neither value supplies authorization or changes the stored tenant boundary.

The layout follows the navigation/conversation distinction in [Slack's sidebar](https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences), the list-to-conversation pattern in [Zulip's recent conversations](https://zulip.com/help/recent-conversations), and optional conversation details in [Mattermost](https://docs.mattermost.com/end-user-guide/collaborate/keyboard-shortcuts). It uses native buttons, links, forms, and disclosures, with its own styling and no copied assets.

## Data contracts

1. `/api/overview` supplies accounts, skills, observed roots, the signed-in principal, and CSRF. The token stays in client memory and POST headers. The list uses available root IDs and account labels; it has no synthetic titles, unread counters, or sender names.
2. `/api/threads/history?root=...` supplies Pi entries, root receipts, selected session, and pagination. Entries render text using escaping. Tool content and the sanitized record inspector start collapsed. A uniquely matching receipt supplies the original staff text, `manager.displayName`, and `sourceTimestamp`.
3. Older pages use `before=pagination.nextBefore`, the selected `session`, and `limit=50`. `pagination.hasMore` controls the older-page button. Entries prepend in native order and deduplicate by entry ID. A selection version prevents late responses from replacing a newer selection.
4. The protected GitHub script retains source scope, draft versions, explicit preview, publication operation IDs, and uncertain-result handling. Git stores the reviewed files. The private authoring conversation remains in the application and renders as messages.
5. Global views preserve form input while switching. The OAuth callback textarea clears before the completion request begins. Inspectors redact credential fields and callback URLs. Account disconnect and authoring-source disable retain their existing confirmation steps.

The conversation view has no reply composer because the admin runtime currently exposes history and controls for received roots. The connection test remains in Accounts and uses its separate diagnostic conversation.

## Run the UI check

From the repository root, after installing the workspace dependencies:

```sh
node apps/cloud-agent/tests/workers/admin-ui-check.mjs
```

The assert-based DOM check executes the actual page script with generated API responses. It checks view selection, transcript escaping and manager names, native pagination, stale-response guards, form preservation, callback clearing, CSRF headers, and Git preview invalidation.

To open the same fixture in a browser:

```sh
node apps/cloud-agent/tests/workers/admin-ui-check.mjs --serve
```

It serves only generated data on `http://127.0.0.1:4178/?root=fixture-alpha`. `ADMIN_UI_FIXTURE_PORT` changes the local port. The fixture makes no provider, GitHub, or production calls and keeps mutations in memory.

Review the conversation list and selected conversation at 375 px, 768 px, and desktop width. At narrow widths, selecting a conversation opens it in place of the list, with a Back to conversations control. Use Tab and Shift+Tab to reach section navigation, search, conversation rows, export, and Details; the hidden views must not receive focus.
