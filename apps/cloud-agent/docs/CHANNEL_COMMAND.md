# Channel Talk App Command and source history

The desk Command `/ai` opens the message-writing WAM without native options. Staff select a workflow inside the panel; Help, Model, Thinking, Ask and History remain available. This is a registered Channel Talk App extension, independent of the automatic public App Hook. Ordinary questions and settings return in the initiating manager's WAM panel. Explicit reviewed workflow sends publish their exact text as a new root or existing-thread reply; AI-only start can create a native root. The quick actions **대화 요약**, **할 일 정리** and **답변 초안** reuse Ask with the selected API or explicitly shared context. They display results only in the panel; missing task owners and deadlines are marked 미정 rather than invented.

The **업무 양식** panel uses [versioned workflow skills](WORKFLOW_SKILLS.md), shared explicit patient/visit selection where requested, editable source candidates, a full-message editor, exact-text review and a separate durable delivery receipt. Its authorized read binding bypasses Pi/general transcripts and requires current business staff/site permission. Read [the visit contract](VISIT_WORKFLOW.md). The old fixed draft action is [legacy compatibility only](DEPRECATED.md); it does not use the durable AI operation lifecycle below.

## Installation

Keep the existing App Function endpoint on the Events origin plus `/functions`. Register `command` with `systemVersion:v1` through the documented app-token `registerExtension` lifecycle; do not replace the existing Hook extension. Configure the app WAM endpoint to the Events origin plus `/wam`, so WAM name `ai` loads `/wam/ai` or `/wam/ai/`. After changing command metadata, refresh `command:v1` registration so AppStore rediscovers the current parameter list. Registration, metadata discovery, installed activation and a real keyboard invocation are separate verification steps. Successful registration does not prove that an installed command snapshot has changed. [Official Command guide](https://developers.channel.io/en/articles/Command-b3d200dc), [WAM bridge](https://github.com/channel-io/app-sdk/blob/main/ts/packages/wam/src/types/wam.ts).

## Updates without reinstalling

Keep `/ai`, its empty parameter list, `commands.ai.open`, the Function origin and the WAM origin stable. Put new workflow choices and controls inside the existing WAM. Both WAM routes return `Cache-Control: no-store`; reopening the panel fetches the current Worker HTML. Already open panels keep their loaded code until reopened. `systemVersion:v1` is the platform contract, not the application release number.

From the private deployment checkout, push reviewed source and deploy the Worker that owns the change:

```sh
# Writing-panel HTML, styles, controls and existing Command handlers.
npm run -w @cf-worker-apps/cloud-agent deploy:events
# AI behavior and existing Assistant actions.
npm run -w @cf-worker-apps/cloud-agent deploy:pi
# Visit adapter, when this installation uses the bundled adapter.
npm run -w @cf-worker-apps/cloud-agent deploy:visit
```

`deploy` continues to mean Pi only. All three aliases forward extra arguments, so append `-- --dry-run` to check a deployment without publishing. Deploy only the configured components that changed. A deployment that uses an external Gateway should deploy that Gateway separately instead of the example Visit worker. These commands use Wrangler and do not alter Channel app permissions or register extensions. Git push by itself does not deploy Workers.

Ordinary UI and implementation changes within the installed contracts need no command re-registration or reinstall. Workflow skill data uses the existing administrator publish/enable flow; a Git push does not automatically activate a skill revision. New published Functions, slash parameters, origins or permissions are a separate app-contract release. Verify discovery and installation, and obtain any newly required permission consent.

### Stale installed command definitions

Do not repeatedly reinstall when the installed description or options disagree with signed `getCommands` output. In one verified deployment, `registerExtension`, command activation toggles and a same-permission reinstall all left the old command snapshot in place. Explicit command-list synchronization using the official historical SDK's `registerCommands(appId, commands, accessToken)` updated it. This establishes an operational recovery for that deployment, not a guarantee for all current installations.

The [official SDK 0.4.2](https://www.npmjs.com/package/@channel.io/app-sdk-server/v/0.4.2) exposes that native method, while the current guide uses `registerExtension`. If this specific mismatch is reproduced, an operator can explicitly synchronize the reviewed complete command list with an app-scoped token. The historical `CommandDTO` has no `systemVersion` field and successful registration may return no `result`. Preserve every intended command and the existing Hook; never replace the list with a partial guessed definition. Keep credentials out of logs and verify the installed list and actual invocation afterward. This legacy operation is not an automatic deploy fallback.

Keyboard selection belongs to the Channel client. In the verified client, the first Ctrl+Enter on an unselected `/ai` suggestion selected the command, and the next Ctrl+Enter executed it. The selected command opened the WAM with no native Options form. The Worker cannot redefine the host's initial autocomplete shortcut.

## Authorization configuration

Both workers require the same private deployment policy:

```json
{
  "COMMAND_GROUP_IDS": "[\"example-public\",\"example-private\"]",
  "COMMAND_PRIVATE_MANAGERS": "{\"example-private\":[\"example-manager\"]}"
}
```

The public automatic group retains its existing Hook boundary. Every other Command group requires an explicit manager allowlist. This is an installation policy, not evidence that an API key inherits the manager's private access. A private source-history read additionally checks current Group metadata membership. Removing a manager or group from configuration invalidates subsequent Command calls.

Only the Assistant worker needs `CHANNEL_OPEN_API_ACCESS_KEY` and `CHANNEL_OPEN_API_ACCESS_SECRET` secret bindings. These credentials authenticate the fixed Open API origin; native app tokens are separate. Keep secrets in the secret manager and platform bindings, never in WAM args, configuration files or the repository. The source API uses `Channel-Version: 2026-06-01`, prohibits redirects and never reads group-wide messages. [Published API contract](https://api-doc.channel.works/docs/openapi.en.yaml).

## Identity and operation lifecycle

Discovery publishes `extension.command.metadata.getCommands`, `commands.ai.open`, `commands.ai.suggest`, `commands.ai.start`, `commands.ai.bindThread`, `commands.ai.execute`, `commands.ai.status`, `commands.ai.workflow` and `commands.ai.visit` alongside existing Hook Functions. The published `/ai` has no parameters or autocomplete reference. Cached-client typed shortcut handling and revision-pinned skill questions are documented in [Staff shortcuts](STAFF_SHORTCUTS.md). All requests use the existing raw-body AppStore signature verification. The bare `/functions` endpoint accepts omitted `systemVersion` for discovery and Command calls, matching the official tutorial. Hook calls and `/functions/v1` require explicit `v1`; other versions are rejected.

Opening requires a signed manager caller, configured Channel and permitted team group. The signed open request may include a root in `trigger.attributes.rootMessageId`. When it does not, the panel reads the selected root from `ChannelIOWam.getWamData("rootMessageId")` and calls the read-only `commands.ai.bindThread` Function. Binding validates the same signed caller, Channel, group policy, capability expiry and root syntax; it preserves the expiry and nonce and rejects changes to an already bound root. It has no Durable Object, queue, source API or model effects. The selected root is supplied by the WAM client, not independently attested by the platform signature. The API reader still validates root/group relationships and current private membership before returning content; directly shared context remains explicit and incomplete. The HMAC capability binds Channel, group, root, manager, a nonce and a 20-minute expiry. Each execution still requires a valid platform signature and the same caller and Channel. The client cannot select a new group or Channel; it can select an initial root only within the capability’s permitted group. Once bound, the capability cannot be retargeted. WAM args contain the capability and a root-presence flag, not echoed host identity keys. The panel distinguishes a signed-open root from a user-selected WAM root. [Official optional-root tutorial](https://github.com/channel-io/app-tutorial-ts/blob/main/server/src/tutorial.functions.ts).

Without either root source, opening and Help have no conversation, model or source API effects. Rootless workflow selection, authorized visit reads, manual edits and exact review run without an Assistant or native write. The final confirmed send creates the reviewed content as the first native message. Ask, History and thread setting changes require a real root. Rootless model/thinking selectors set the reviewed initial intent. A source tuple uses the same `channel-SHA256([channel,group,root])` Assistant key as the automatic path; equal root strings in different groups stay separate. The management UI uses the registered thread key and refuses ambiguous root-only selection.

The WAM validates blank questions locally and shows progress before calling the bridge. Explicit pre-admission input rejection lets the user correct their input and use another action. Transport uncertainty and unknown admission failures retain the same UUID and body for a safe retry, including the exact quick-action prompt and selected context. The WAM creates one explicit UUID per action and keeps its body unchanged until its outcome is known. Assistant SQLite stores pending operation state and snapshots. Pi inference reuses the UUID's stable submission ID. The original ask prompt and context, canonical Pi transcript and final Command receipts reside in tenant-scoped D1. After a confirmed final D1 receipt, SQLite retains only the request hash and state, clearing raw question, context, response and snapshot. Lost receipt responses resume from D1 without another model call. Interrupted setting changes return an uncertain receipt and are never repeated automatically. Each root admits at most 2,000 Command receipts; administrator retention tooling is a later extension.

## Full available source history

History and normal Ask read the exact known Group metadata, thread root, then ascending reply pages of at most 100. The reader validates returned Channel/group/root relationships, removed state, writers, timestamps, duplicate IDs, pagination shape and cursor progress. It keeps staff/bot ID, display name, timestamp, plain text and attachment count. Side-loaded email, phone, profiles, attachment keys and URLs are discarded; files are not fetched.

The read-only Pi tool `get_source_thread_history` accepts only optional `cursor` and `limit`; its target is the actor's pinned source and active initiating operation. It remains available through harness initialization and skill snapshot preparation. There is no arbitrary URL or group/root parameter. Source text is untrusted context and cannot change tools, credentials or delivery targets.

A traversal is bounded to 10 reply pages, 1,000 normalized messages, 1 MiB input, 256 KiB output and 15 seconds. `complete:false`, `incompleteReason` and `nextCursor` describe limits; repeated tool calls can continue. A continuation includes the root again. New replies during traversal mean this is not an atomic snapshot. A root response or one default page is never described as full history.

The current Open API contract does not promise API-key access to private groups. An HTTP 401/403 appears as `source_history_api_denied`; normal Ask fails before model inference. It never fabricates an empty complete history or silently switches to another group. No native full-history API has been established by the reviewed public SDK. Current live installation eligibility must be reported separately from local fixtures.

The manager may explicitly select **directly shared context** and paste copied text. That Ask skips source API requests, including tool-triggered requests, labels the result `contextSource:shared`, and always reports source completeness as false. It uses the same signed target, manager policy, UUID deduplication and D1 persistence. This is voluntary user sharing, not automatic private history retrieval or a fallback after denial.

## Reproducible checks

```sh
npm run -w @cf-worker-apps/cloud-agent build
npm run -w @cf-worker-apps/cloud-agent command-check
npm run -w @cf-worker-apps/cloud-agent command-ui-check
```

The native workerd check uses generated identities, SQLite Durable Objects, D1, the real Pi Harness and mocked outbound APIs. It verifies trailing-slash WAM loading, signed discovery/open, read-only host-root binding, wrong-caller/expired/invalid-root/retarget denial, caller/capability binding, missing roots, model/thinking/help/ask/history, exact-thread pagination, malformed responses, identity/duplicate/cursor/budget guards, explicit private denial before inference, shared-context opt-in, operation conflicts, restart persistence and zero Channel writes. DOM checks verify WAM initialization, root badges, missing-root controls, text rendering, stable retry bodies and retained drafts, blank-input recovery, explicit rejection recovery, immediate progress and quick-action context persistence. These checks do not prove production Command activation or private API permission.
