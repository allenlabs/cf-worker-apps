# New team-chat work before a thread exists

The main team-chat composer can run `/ai` before any source thread exists. Staff select a workflow, select any required patient and visit, edit the form, review its exact text and confirm **새 스레드 첫 메시지로 보내기**. That reviewed text becomes the first native message. Opening, selecting, prefilling, editing and reviewing create no placeholder and require no inference account. Manual forms never query the visit backend. Existing threads send the reviewed form as a reply.

Model and thinking choices remain available before sending. Changing either clears the reviewed draft and confirmations. The signed review binds those settings, the workflow revision, source, values, exact text, confirmation set and original launch capability including its nonce. Optional AI authoring, general questions and history become available after a real root exists. When no workflow is selected, **새 업무 시작** retains the simple AI-only native root path. A direct start request selecting a workflow without reviewed form content is rejected.

## Ownership and bindings

| Action | Owner | Effect |
| --- | --- | --- |
| `commands.ai.start` `options` | Credentials owner | Reads enabled published workflow resources and configured model/thinking choices |
| Rootless workflow `catalog`, `prefill`, `prepare` | Credentials definition scope; Events review protocol | Authorizes any required source read, renders exact text and signs its review; no native write or Assistant |
| Rootless workflow `send` | Credentials owner | Renders the reviewed values again, claims UUID and original launch nonce, writes the native root and stores initial intent |
| Rootless workflow `status` | Credentials owner | Checks review digest and existing start receipt; never sends native creation again |
| First rooted AI operation | Real-root Assistant | Selects/pins account and applies initial model/thinking once before inference |

Events uses `PI_ASSISTANT` and `PI_CREDENTIALS` bindings to the existing classes. No new namespace, credential owner, inference account or draft store is introduced. The shared `VisitReadTarget` permits a group read without a root; `VisitTarget`, source history and Pi/Channel MCP identities still require a real root. Every read retains current business authorization. See [visit reads](VISIT_WORKFLOW.md) and [reviewed forms](WORKFLOW_SKILLS.md).

The owner stores the review digest and text hash alongside ordinary start metadata. It never stores form values, rendered clinical text or source context in the start receipt, D1 transcript or Pi history. Native send uses server-rendered text, `broadcast:false` and no `rootMessageId`. Only a successful ready receipt lets Events issue the real-root capability. Pending UI status checks retain the original rootless capability and review token.

## Durable creation and recovery

The owner stores `creating → created → ready`, or `failed` / `uncertain`. It persists a known root ID before installing preferences. The request digest covers tenant, full launch target, intent and reviewed message digest/hash. The request UUID and launch nonce are immutable, including after failure or abandonment. A different UUID cannot create another root from the same panel launch. The native SDK exposes `requestId`, but upstream deduplication is unproven; safety comes from the local durable claim.

An ambiguous response, malformed or conflicting message identity, network failure after issue, or HTTP 5xx leaves creation uncertain. A persisted `creating` claim after restart also remains uncertain. Status never repeats native creation. A persisted `created` root finishes preferences without another native write. Confirmed success preserves the form's reviewed text in the panel and does not send it again as a reply.

While creation is unresolved, new unregistered roots in that group are held before lifecycle start, account selection, Pi or inference; already registered roots remain usable. The hold has no silent TTL. Events retains ordered pending delivery per thread. The Super Admin page's **관리 기록 → 새 업무 시작 결과 확인** lists up to 50 unresolved receipts. Its SSO/CSRF-protected recovery can bind a manually verified native root to that operation or explicitly abandon setup. Abandonment releases its group hold, preserves receipt/nonce and never deletes or resends a message. In-flight creates and roots already admitted to AI cannot be rebound. Exact recovery replay is idempotent.

The owner retains at most 2,000 start receipts and fails closed when full. An operational archive/migration is required beyond that ceiling; deleting receipts ad hoc weakens replay protection. Creation requires `ALLOWED_CHAT_ID` and enabled replies. Workflow roots additionally require `VISIT_MCP_GROUP_ID`, matching existing form delivery policy. Current manager/group authorization is checked on each request.

## Verification

```sh
npm run -w @cf-worker-apps/cloud-agent build
npm run -w @cf-worker-apps/cloud-agent command-start-check
npm run -w @cf-worker-apps/cloud-agent command-start-ui-check
npm run -w @cf-worker-apps/cloud-agent workflow-check
npm run -w @cf-worker-apps/cloud-agent gateway-check
```

The workerd checks use generated identities and mocked outbound APIs. They verify exact reviewed root text, no placeholder/Assistant before send, source and settings tampering, nonce/UUID conflicts, concurrent/restarted/uncertain no-resend, native response metadata, original-capability status, first preferences and administrator recovery. DOM checks exercise manual and visit forms, multiline edits, confirmation reset, settings changes, lost responses and rooted continuation. These checks do not prove hosted native-client layout, installed business authorization or a live send. Required coverage may fail separately when workerd does not expose its Profiler API; no coverage percentage is claimed in that case.
