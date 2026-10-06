# Start a team-chat thread with initial settings

The main team-chat composer can run `/ai` before any source thread exists. The panel shows **workflow → model → thinking level → 새 업무 시작**. Root-dependent forms, questions and history remain hidden until an actual native root is known. Existing thread composer commands keep their root settings. Employee model/thinking defaults and optional skill autocomplete are described in [Staff shortcuts](STAFF_SHORTCUTS.md).

Choosing an item does not start AI or read patient data. Clicking **새 업무 시작** creates one bot-authored native root in the configured reply group, binds a new signed capability to its returned message ID and continues the selected workflow in the same panel. The bot root itself does not trigger inference. A workflow without source data needs no inference account. Visit-backed forms still require an explicit patient and visit after creation, through the existing authorized adapter.

## Ownership and admission

| Operation | Owner | Effects |
| --- | --- | --- |
| `commands.ai.start` `options` | Existing Credentials owner DO | Reads enabled published workflow resources and configured model/thinking choices only |
| `create` | Same owner | Claims UUID + one capability launch nonce; writes native root; stores initial intent |
| `status` | Same owner | Reads receipt, finishes a known root's preferences when necessary; never sends native creation again |
| First staff AI message or rooted AI command | Real-root Assistant DO | Selects/pins account, applies initial model/thinking once before inference/settings snapshot |
| Later settings changes | Same Assistant | Persist normally; restarting or replaying start never restores old defaults |

Events uses two external DO bindings: `PI_ASSISTANT` targets the existing Assistant class and `PI_CREDENTIALS` targets the existing Credentials class of the same runtime. Neither creates another namespace or credential owner. Existing OAuth grants, wrapping AAD, secrets and source identities remain in their original deployment.

Rootless options do not instantiate an Assistant, call Pi, query account metadata, rotate account assignment, read history/patient/visit data or call native APIs. Source reads, reviewed drafts and final form delivery still require a signed real-root capability. Initial setup does not alter account defaults.

## Durable receipt and recovery

The owner stores `creating → created → ready`, or `failed` / `uncertain`. It persists a known root ID before installing preferences. The request UUID and launch nonce are immutable, including after failure or abandonment. A different UUID cannot create another root from the same panel launch. The native SDK exposes `requestId`, but upstream deduplication is unproven; safety comes from the local durable claim, not a deduplication assumption.

An ambiguous response, malformed or conflicting message identity, network failure after issue, or HTTP 5xx leaves the creation uncertain. A persisted `creating` claim after restart also remains uncertain. Status never repeats native creation. A persisted `created` root finishes setup without another native write.

While root creation is unresolved, new unregistered roots in that group are held before lifecycle start, account selection, Pi or inference; already registered roots remain usable. The hold has no silent TTL. The Events outbox selects due first heads per thread and schedules the earliest eligible head: a backoff or quarantined new root cannot block already registered roots, while each root retains FIFO delivery. Exact admin recovery replay is idempotent; a changed action/root is refused. The Super Admin management page's **관리 기록 → 새 업무 시작 결과 확인** lists up to 50 unresolved receipts. Through the existing SSO session and same-origin CSRF mutation, the administrator can either bind a manually verified native root to that exact operation or explicitly abandon setup. Abandonment releases only its group hold, preserves the receipt/nonce, and never deletes or resends a message. Active in-flight creates cannot be recovered. Binding a root already admitted to AI is refused so settings cannot overwrite an active thread.

The owner retains at most 2,000 start receipts and fails closed when full. An operational archive/migration is required beyond that ceiling; deleting receipts ad hoc would weaken replay protection. This feature currently creates roots only in `ALLOWED_CHAT_ID` with replies enabled; the visit adapter's group configuration is independent.

## Reproduce the checks

```bash
npm run -w @cf-worker-apps/cloud-agent build
npm run -w @cf-worker-apps/cloud-agent command-start-check
npm run -w @cf-worker-apps/cloud-agent command-start-ui-check
npm run -w @cf-worker-apps/cloud-agent command-check
npm run -w @cf-worker-apps/cloud-agent command-ui-check
npm run -w @cf-worker-apps/cloud-agent workflow-check
npm run -w @cf-worker-apps/cloud-agent visit-ui-check
npm run -w @cf-worker-apps/cloud-agent admin-ui-check
```

The native behavioral check uses generated identities in Miniflare/workerd. It covers account-free discovery/forms, exact native target, minimal opaque native response, UUID/nonce conflicts, creating/created/ready crash points, high initial thinking before a real faux-provider generation, a later low setting after restart, held-native early-reply quarantine, existing-root continuity, uncertain no-resend and SSO/CSRF recovery. The DOM checks exercise actual selection-change and button-click handlers, retained creation UUID after lost response, status-only continuation, settings-before-start layout order, and refresh without a hidden stale workflow.

The faux provider exposes one probe model: local tests prove persisted requested model intent and actual thinking behavior. Selecting a non-default production model still requires hosted-provider verification. DOM order/visibility checks do not replace a 620px hosted popup screenshot. Coverage is run through the existing app command without reducing thresholds; an unavailable workerd Profiler must be reported separately from behavioral success.
