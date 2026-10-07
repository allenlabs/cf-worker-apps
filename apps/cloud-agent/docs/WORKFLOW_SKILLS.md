# Versioned customer workflow forms

Administrators can add a customer form without changing runtime code. A normal hosted skill bundle contains `SKILL.md` and the reserved text resource `references/workflow.json`. The `/ai` panel lists enabled workflow skills, pins the selected content revision, fills authorized source candidates and renders the declared fields. Staff edit the full message, review its exact text, check the requested confirmations and explicitly send it as a new native root or a reply in their current approved thread. This path does not use a model account or grant a message-send tool to Pi.

The [visit handoff](../skills/workflows/visit-handoff/SKILL.md) and [manual notice](../skills/workflows/staff-notice/SKILL.md) examples use the same runner. Keep customer definitions in Git. Upload `SKILL.md` as rawContent and its JSON as a `reference` resource at `references/workflow.json` through the existing administrator skill bundle publish UI/API. Publishing creates a retained content-hash revision and leaves it disabled. Review, enable, and refresh the staff panel's catalog. The hosted registry supports text resources; no scripts or `agents/openai.yaml` belong in these bundles. GitHub authoring can maintain these source files, but publication to the enabled hosted catalog remains an explicit administrator action.

## Definition contract

```json
{
  "schemaVersion": 1,
  "title": "Staff notice",
  "source": "none",
  "fields": [
    {"id":"team","label":"Team","type":"choice","required":true,"maxLength":20,"choices":["Operations","Support"]},
    {"id":"notice","label":"Notice","type":"text","required":true,"maxLength":500}
  ],
  "template": "{{team}}\n{{notice}}",
  "confirmations": [{"id":"review","label":"I checked the message and current thread."}]
}
```

Definitions have only these keys. IDs use lower-case letters, digits and underscores, starting with a letter. There are at most 20 fields and 10 checks. Fields are `text` or `choice`, with an explicit required flag and maximum length of 1–1,000 characters. Choice lists contain 1–20 distinct nonempty strings. Required choices begin empty in the UI. No choice or approval becomes true from a database read or model inference. Templates replace only declared `{{fieldId}}` placeholders. Expressions, scripts, executable URLs, SQL selectors, destinations, credentials and tenant selection are unsupported. The definition JSON is capped at 32 KiB and the outgoing message at 4,000 UTF-16 code units / 16,000 UTF-8 bytes. Validation runs at publish and every retained-revision load.

`source:"none"` never queries the visit adapter. Staff enter the form values manually. `source:"visit-context"` uses the existing authorized `VISIT_API`/Gateway path. Staff explicitly select the patient, even when only one patient matches. That selection immediately prepares patient-level fields and available intake candidates. An absent schedule is valid: `selection.visitId` is normalized to `null`, while `WorkflowSource.visit` and `.reservation` are `null`. No schedule is selected automatically, including a sole returned schedule.

The folded **일정 정보 추가 (선택)** section offers optional schedules with readable dates, purpose, linked appointment time and status instead of record IDs or database links. Staff can finish a patient-only message without opening it. Choosing **일정 없이 작성** clears all derived visit/reservation fields and rereads the authorized patient-only source. Multiple, missing, cancelled or ambiguous schedule candidates cannot block patient-only work. Indistinguishable labels cannot be selected. Date-only values keep their calendar date; timestamps use the browser's local time zone. Missing booking links use **진료 일정** and provide no booking candidates. The read contract returns at most 20 schedules and does not claim a complete inventory. A field can map one of:

- `patient.label` or `patient.reference`.
- `visit.date` or `visit.status` for the selected visit.
- `reservation.at`, `reservation.type`, `reservation.status`, `reservation.procedureText`, `reservation.note` or `reservation.pod` for that visit's linked reservation.
- `intake.concernText` for the explicitly selected patient, with or without a selected visit.

Patient and selected-visit fields are read-only. Reservation fields and `intake.concernText` are editable candidates. There is no fallback to the first/latest reservation. No link means blank reservation values. `procedureText` and `note` are optional, nullable projected text capped at 1,000 characters; `pod` is optional, nullable text capped at 40 characters. They are discarded on every unrelated or unselected reservation. Optional `intake:{concernText:string|null}` is projected after the selected patient validates, with a 1,000-character concern ceiling, including when no schedule is selected. The backend must authorize and associate the intake with that patient before returning it; the common contract cannot verify undisclosed database ownership. Other intake properties are discarded. Older backends can omit either new candidate and its field stays blank. An installation can impose a smaller ceiling. POD is supplied text, never calculated from a date. A procedure menu is not a clinical fact and cannot establish revision status. Put that decision in an explicit staff field/check.

For example, a synthetic visit-backed form can declare:

```json
[
  {"id":"concern","label":"Intake concern","type":"text","required":false,"maxLength":500,"source":"intake.concernText"},
  {"id":"pod","label":"POD","type":"text","required":false,"maxLength":40,"source":"reservation.pod"}
]
```

Selecting a patient fills available patient/intake candidates automatically; explicitly adding a schedule also supplies its linked reservation candidates; no AI description or model call is required. A complete valid prefill also fills the **보낼 메시지** editor automatically; missing required staff values stay visible under **항목별로 수정**. Staff can replace the whole message, including headings and template lines. Editing this body does not change the selected database record or bypass required field and source checks. The selected patient/visit remains separate metadata: staff must confirm that their wording is appropriate. Required staff facts remain required; making the schedule optional does not bypass definition validation. The example handoff makes `visit.date` optional so patient-only work is possible, while its consultation details, revision choice and exception field still require staff input. The test-data notice stays outside the outgoing body. Message edits clear review and confirmations but survive re-review and failed preparation. Field or selection changes reset the composed message; model/thinking changes preserve it while requiring another review. AI assistance is available after a real thread exists, in a folded optional section for visit forms. Before a thread exists, the same deterministic form and patient/visit picker work without creating any message. Final review and confirmation create the completed form as the first native message. Changing between visit-backed forms keeps the selected patient and optional visit, clears all old edits, checks and preview, and rereads authorization and candidates before filling the new form. Changing to a manual form or refreshing the catalog clears that selection.

Each backend read must enforce current staff/site/dataset authorization. The generic administrator and Channel group policy do not grant clinical access. The supplied examples do not enable production data. Current multi-customer support means tenant-isolated installations with a fixed deployment `TENANT_ID` and tenant-pinned owner Credentials/Assistant objects. There is no browser tenant switch or shared-host cross-tenant catalog.

## Signed actions and review token

`commands.ai.workflow` shares the platform signature, manager identity, target capability expiry and group policy. A real root uses its fixed Assistant binding; a rootless launch uses the Credentials owner for the existing root-creation ledger. Extra input properties are rejected. The actions are:

1. `catalog` returns current enabled workflow definitions and content revisions.
2. `prefill` accepts name/revision and, for visit sources, `{patientId,visitId?:UUID|null}`. The patient is required; omitted and null `visitId` normalize to the same `{patientId,visitId:null}` selection before review hashes are computed. It performs an authorized fresh read and returns initial message text when all required values are valid.
3. `prepare` adds the exact declared values and optional `finalText`. It rereads the selected source and validates the values. Without `finalText`, it renders the template; supplied text is the independent staff-authored body. It must be nonblank, within the message bounds, and free of disallowed control characters. Accepted whitespace and newlines are preserved exactly. Rootless preparation also requires `{intent:{modelId,thinkingLevel}}`. It returns a new operation UUID, exact text, a ten-minute draft token and expiry.
4. `send` requires that UUID, token, exact values/selection and optional `finalText` from the review, `confirmed:true`, and all declared confirmation IDs. `status` accepts the same UUID/token and never sends.

The HMAC token is authenticated, not encrypted. It contains only the operation ID, skill name/revision, expiry and hashes binding the manager/group/root-or-launch/tenant actor scope, delivery mode, model/thinking intent, selection, final values, exact text and whether authored text was supplied, source projection and confirmation IDs. It contains no patient IDs, labels, source text or field contents. Do not put it in URLs or logs. The actual source hash excludes observation time so a fresh read timestamp alone does not invalidate a review. It includes the selected patient, visit and reservation IDs and their relationship, patient identity, visit status/date, linked reservation facts and projected intake concern. IDs are internal hash inputs, not available field source paths. Source changes, message edits, field edits, selected patient/visit changes, model/thinking changes and confirmation changes require a fresh review. A new token cannot be reused under another operation UUID.

Before the first send, the route rechecks current enabled skill state and rereads authorization/source facts. It compares the effective message and hashes with the review token. Optional text presence and bytes are checked before any receipt replay, so omission or alteration of a reviewed edit cannot reuse the operation. The selected owner also checks tenant pin, exact target, current skill revision and configured `VISIT_MCP_GROUP_ID` plus reply policy. Both delivery owners independently validate the base values, authored text and text hash. A rooted Assistant sends that exact body using the owner Channel credential, the pinned source root and `broadcast:false`. For rootless work, Credentials creates the same reviewed body as a native message without `rootMessageId`; its existing start ledger binds the review digest, full launch nonce and initial settings. Events returns a capability for the real root only after the receipt is ready. Definitions cannot change the destination. The internal RPC is available only through trusted service bindings; it is not registered as a Pi tool or public HTTP endpoint.

Rooted delivery stores only the request digest, optional authored-text hash, state and optional native reply ID in the dedicated Assistant receipt. Rootless delivery uses the existing Credentials start receipt with ordinary target/intent metadata, review digest and text hash; it stores no form/source text. No clinical drafts, fields or source context enter generic command operations, D1 transcripts or Pi sessions. A durable sending claim precedes native HTTP. Replays return the existing receipt without another source read or send, including after source changes or skill disable. A crash or ambiguous response leaves the request uncertain and prevents automatic resend. The UI retains the original operation and offers status confirmation.

## Verification

Run `npm run -w @cf-worker-apps/cloud-agent workflow-check` after `npm run -w @cf-worker-apps/cloud-agent build`. The workerd suite publishes two fictional customer forms, checks explicit patient-only work with no/one returned schedule, nullable visit/reservation sources, bounded patient intake with no schedule, selected-only reservation projection, revision pin/disable, bound digest-only tokens, changed source/authorization, unchecked confirmations, full-message bounds, exact authored root/reply sends, text presence/byte tampering before replay, replay/conflict, cold restart, uncertain sending and transcript isolation. `visit-ui-check` exercises actual rendered DOM controls, editable candidates, invalidation/stale responses and lost-response status. These use generated identities and mocked outbound services. They do not prove a deployment's actual clinical authorization or a live native send.

The old fixed `commands.ai.visit` draft action remains for active compatibility clients only. See [DEPRECATED.md](DEPRECATED.md). New forms use workflow skills.
