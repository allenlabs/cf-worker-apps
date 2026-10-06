# Channel Talk App Command and source history

The desk Command `/ai` opens a WAM panel for Help, Model, Thinking, Ask and History. This is a registered Channel Talk App extension, independent of the automatic public App Hook. No Command operation publishes a Channel Talk message. Its answer appears in the initiating manager's WAM panel. The quick actions **대화 요약**, **할 일 정리** and **답변 초안** reuse Ask with the selected API or explicitly shared context. They display results only in the panel; missing task owners and deadlines are marked 미정 rather than invented.

The **업무 양식** panel uses [versioned workflow skills](WORKFLOW_SKILLS.md), shared explicit patient/visit selection where requested, editable source candidates, exact-text review and a separate durable delivery receipt. Its authorized read binding bypasses Pi/general transcripts and requires current business staff/site permission. Read [the visit contract](VISIT_WORKFLOW.md). The old fixed draft action is [legacy compatibility only](DEPRECATED.md); it does not use the durable AI operation lifecycle below.

## Installation

Keep the existing App Function endpoint on the Events origin plus `/functions`. Register `command` with `systemVersion:v1` through the documented app-token `registerExtension` lifecycle; do not replace the existing Hook extension. Configure the app WAM endpoint to the Events origin plus `/wam`, so WAM name `ai` loads `/wam/ai` or `/wam/ai/`. Registration, metadata discovery, installed activation and a real invocation are separate verification steps. [Official Command guide](https://developers.channel.io/en/articles/Command-b3d200dc), [WAM bridge](https://github.com/channel-io/app-sdk/blob/main/ts/packages/wam/src/types/wam.ts).

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

Discovery publishes `extension.command.metadata.getCommands`, `commands.ai.open`, `commands.ai.bindThread`, `commands.ai.execute`, `commands.ai.status` and `commands.ai.visit` alongside existing Hook Functions. All requests use the existing raw-body AppStore signature verification. The bare `/functions` endpoint accepts omitted `systemVersion` for discovery and Command calls, matching the official tutorial. Hook calls and `/functions/v1` require explicit `v1`; other versions are rejected.

Opening requires a signed manager caller, configured Channel and permitted team group. The signed open request may include a root in `trigger.attributes.rootMessageId`. When it does not, the panel reads the selected root from `ChannelIOWam.getWamData("rootMessageId")` and calls the read-only `commands.ai.bindThread` Function. Binding validates the same signed caller, Channel, group policy, capability expiry and root syntax; it preserves the expiry and nonce and rejects changes to an already bound root. It has no Durable Object, queue, source API or model effects. The selected root is supplied by the WAM client, not independently attested by the platform signature. The API reader still validates root/group relationships and current private membership before returning content; directly shared context remains explicit and incomplete. The HMAC capability binds Channel, group, root, manager, a nonce and a 20-minute expiry. Each execution still requires a valid platform signature and the same caller and Channel. The client cannot select a new group or Channel; it can select an initial root only within the capability’s permitted group. Once bound, the capability cannot be retargeted. WAM args contain the capability and a root-presence flag, not echoed host identity keys. The panel distinguishes a signed-open root from a user-selected WAM root. [Official optional-root tutorial](https://github.com/channel-io/app-tutorial-ts/blob/main/server/src/tutorial.functions.ts).

Without either root source, opening and Help have no conversation, model or source API effects. Ask, History, Model and Thinking require invocation from a thread's comment composer. A source tuple uses the same `channel-SHA256([channel,group,root])` Assistant key as the automatic path; equal root strings in different groups stay separate. The management UI uses the registered thread key and refuses ambiguous root-only selection.

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
