# New team-chat work before a thread exists

The main team-chat composer can run `/ai` before any source thread exists. Staff select a workflow, select any required patient and visit, complete required fields, edit the full **보낼 메시지** body, review its exact text and confirm **새 스레드 첫 메시지로 보내기**. That reviewed text becomes the first native message. Opening, selecting, prefilling, editing and reviewing create no placeholder and require no inference account. Manual forms never query the visit backend. Existing threads send the reviewed form as a reply.

Model and thinking choices remain available before sending. Changing either clears the review and confirmations while preserving edited message text. Changing the workflow, patient, visit or base fields resets the message. A complete valid prefill fills the editor automatically. Editing the message does not change the selected database record. The signed review binds those settings, the workflow revision, source, values, exact text, confirmation set and original launch capability including its nonce. Optional AI authoring, general questions and history become available after a real root exists. When no workflow is selected, **새 업무 시작** retains the simple AI-only native root path. A direct start request selecting a workflow without reviewed form content is rejected.

The WAM requests a 760 × 520 window. The compact height leaves room for native floating-window chrome at the tested desktop placement. The public WAM bridge exposes size but not the outer viewport or window position, so this fixed height is not universal viewport detection; a new size request takes effect when the panel is reopened. It places source selection beside the editable message and stacks them below 600 px. Review, confirmation and send stay in a separate footer, so scrolling the form cannot cover them. A selected patient and visit remain visible in a compact source summary; additional source facts, optional form fields and AI tools use native disclosures. Missing required fields appear before the empty editor. Staff can press Enter to search after entering at least two characters, and then explicitly select the patient and visit. IME composition does not trigger a search.

The primary action follows the existing review state. It starts as **보낼 내용 검토**, becomes send after review, and becomes **보낸 요청 결과 확인** while delivery is unresolved. Editing the message clears confirmation and returns to review. Model/thinking and help remain available through the header's **설정 · 도움말** menu. Rootless forms hide thread-only shared context. The layout includes visible keyboard focus and a system dark-color preference.

## Ownership and bindings

| Action | Owner | Effect |
| --- | --- | --- |
| `commands.ai.start` `options` | Credentials owner | Reads enabled published workflow resources and configured model/thinking choices |
| Rootless workflow `catalog`, `prefill`, `prepare` | Credentials definition scope; Events review protocol | Authorizes any required source read, validates fields and optional authored text, and signs the exact review; no native write or Assistant |
| Rootless workflow `send` | Credentials owner | Validates reviewed fields and exact authored text/hash, claims UUID and original launch nonce, writes the native root and stores initial intent |
| Rootless workflow `status` | Credentials owner | Checks review digest and existing start receipt; never sends native creation again |
| First rooted AI operation | Real-root Assistant | Selects/pins account and applies initial model/thinking once before inference |

Events uses `PI_ASSISTANT` and `PI_CREDENTIALS` bindings to the existing classes. No new namespace, credential owner, inference account or draft store is introduced. The shared `VisitReadTarget` permits a group read without a root; `VisitTarget`, source history and Pi/Channel MCP identities still require a real root. Every read retains current business authorization. See [visit reads](VISIT_WORKFLOW.md) and [reviewed forms](WORKFLOW_SKILLS.md).

The owner stores the review digest and text hash alongside ordinary start metadata. It never stores form values, rendered clinical text or source context in the start receipt, D1 transcript or Pi history. Native send uses the exact reviewed message, `broadcast:false` and no `rootMessageId`. Only a successful ready receipt lets Events issue the real-root capability. Pending UI status checks retain the original rootless capability and review token.

## Durable creation and recovery

The owner stores `creating → created → ready`, or `failed` / `uncertain`. It persists a known root ID before installing preferences. The request digest covers tenant, full launch target, intent and reviewed message digest/hash, including whether an edited body was supplied. Changed or omitted authored text is rejected before receipt replay. The request UUID and launch nonce are immutable, including after failure or abandonment. A different UUID cannot create another root from the same panel launch. The native SDK exposes `requestId`, but upstream deduplication is unproven; safety comes from the local durable claim.

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

The workerd checks use generated identities and mocked outbound APIs. They verify exact reviewed root text, no placeholder/Assistant before send, source and settings tampering, nonce/UUID conflicts, concurrent/restarted/uncertain no-resend, native response metadata, original-capability status, first preferences and administrator recovery. DOM checks exercise manual and visit forms, whole-message edits, preserved re-review text, confirmation reset, settings changes, lost responses and rooted continuation. These checks do not prove hosted native-client layout, installed business authorization or a live send. Required coverage may fail separately when workerd does not expose its Profiler API; no coverage percentage is claimed in that case.
