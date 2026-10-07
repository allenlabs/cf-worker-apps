# Visit read contract and legacy drafts

The current `/ai` WAM uses [versioned customer workflow skills](WORKFLOW_SKILLS.md). Its shared patient/visit picker and authorized reads remain live. The rest of this document records the fixed `commands.ai.visit action="draft"` compatibility API; its old WAM fields/buttons were removed. Do not extend that draft API. See [DEPRECATED.md](DEPRECATED.md).


The legacy fixed draft API explicitly selects a patient and visit, validates arrival/treatment fields and displays a deterministic draft. This API sends no message and changes no reservation, visit, status, clinical record or billing record. It requires no connected model account. The current WAM uses the shared read picker inside workflow skill forms; its separate workflow send action has an explicit review and delivery receipt.

## Runtime boundary

The existing signed App Function ingress discovers `commands.ai.visit`. Its strict parameters are:

```js
// One action per request; extra properties are rejected.
{ targetCapability, action: "patientSearch", query: "Synthetic person" }
{ targetCapability, action: "visitSelect", patientId, visitId: null }
{ targetCapability, action: "visitSelect", patientId, visitId }
{ targetCapability, action: "draft", patientId, visitId, fields: {
  kind: "arrival", // or "treatment"
  concernArea: "Confirmed area",
  revision: "unknown", // unknown | yes | no
  schedulingExceptions: "None",
  externalNameChecked: "unknown" // unknown | yes | no
} }
```

The same raw-body platform signature, caller, Channel/group policy, HMAC capability expiry and immutable bound root checks apply to every request. Patient search and visit selection also accept a signed group launch before a root exists. The legacy draft action still requires a root. The caller cannot provide a tenant, site, subject, role, dataset, table, SQL, endpoint, arbitrary prompt or model configuration. The selected root may have originated from the existing explicit WAM root-selection path; it does not establish medical authorization.

The Events Worker forwards only server-resolved `{ channelId, groupId, managerId, rootMessageId? }` and parsed input to the fixed `VISIT_API` service binding. Its request authenticates with the secret `VISIT_SERVICE_TOKEN`. The separate `workers/visit` Worker has no Durable Objects, queues, D1 binding, public route, workers.dev or preview URL. Its only outbound API is the configured HTTPS Supabase origin plus `/rest/v1/rpc/cloud_agent_visit_read`. It supplies the fixed deployment `TENANT_ID`, never a client tenant. Credentials stay inside this Worker. Supabase requests use `apikey`; a legacy `eyJ` JWT also receives a Bearer header, while new secret keys do not.

A host can insert the [Visit Gateway](VISIT_GATEWAY.md) between Events and the backend. The Gateway separates its Channel ingress credential from the backend credential and supports authenticated server-derived MCP reads with a distinct identity source. Channel request bodies and the legacy RPC actor stay unchanged.

The read target permits an omitted root; supplied roots must remain valid nonempty IDs. Unknown target keys are rejected. Thread identity, source history and Pi/Channel MCP continue to use the strict real-root target. An installation must adopt this optional-root read contract in its Gateway and RPC before enabling rootless reads.

The RPC owns the current Channel manager → business subject/site mapping, active staff status, actual read/draft feature permission and permitted dataset. A generic Cloud Agent administrator or Channel group allowlist does not grant clinical access. Each search, context read and draft reread must recheck this authorization. Production data must remain disabled until this mapping and permission check exist. Test mode is an authorization-controlled synthetic dataset, not a user-selectable shortcut to real records.

Draft rendering is deterministic and reads the selected patient/visit again through the RPC. Unknown/empty confirmation fields remain **확인 필요**/**미입력**; an unchecked external name keeps the draft unready. No LLM infers clinical facts or destinations. Context and drafts never enter general Ask, shared-context fields, source history, Pi sessions, generic D1 transcripts or command receipts. Native `#` templates are unchanged.

## Business RPC contract

The fixed RPC accepts:

```json
{
  "p_actor": {
    "tenantId": "example-tenant",
    "channelId": "example-channel",
    "groupId": "example-test-group",
    "rootMessageId": "example-root",
    "managerId": "example-manager"
  },
  "p_input": { "action": "visitSelect", "patientId": "10000000-0000-0000-0000-000000000001", "visitId": null }
}
```

`p_input` has only `patientSearch` or `visitSelect`; `draft` is never a database action. Search returns `{mode:"test"|"live",kind:"patients",patients:[{id,label,reference:null|string}]}`. Selection returns `{mode,kind:"context",patient:{id,label,reference},reservations:[{id,at:null|ISO,type:null|string,status:null|string}],visits:[{id,date:null|ISO,reservationId:null|UUID,status:null|string}],selectedVisitId:null|UUID,observedAt:ISO}`. An omitted/null visit is unselected, not the latest visit. A non-null visit must be in the returned patient's authorized site, and each non-null visit reservation link must refer to a returned reservation belonging to that same patient/site. The private RPC enforces those relationships before projection; the Worker can verify only projected IDs/links, not undisclosed database ownership. Optional `intake:{concernText:string|null}` is a patient-owned source and can be returned after patient authorization even when `selectedVisitId` is null. Its concern text is capped at 1,000 characters; extra intake fields are dropped. The backend must enforce same-patient ownership. By contrast, reservation `procedureText`, `note` and `pod` are projected only for the explicitly selected visit’s linked reservation; an unselected schedule never supplies these candidates.

The mode comes from server dataset policy. Output is capped at 20 patients, 20 reservations, 20 visits and 64 KiB. Labels are capped at 200 characters, references at 120, type/status at 80. Search is 2–64 characters, concern at most 200 and exceptions at most 500; null bytes and extra input properties are rejected. Backend profile properties are discarded by projection. The UI labels bounded choices as a maximum rather than claiming a complete record inventory.

An installation RPC can use a narrow example schema like this; these fictional names do not describe an existing organization's schema:

```sql
-- Illustrative source model, not an installation migration.
-- example_visit.staff_scope(tenant_id, channel_id, group_id, manager_id,
--   subject_id, site_id, active, can_read_visits, data_mode)
-- example_visit.patient(id uuid, site_id, active, display_label, reference)
-- example_visit.reservation(id uuid, patient_id uuid, site_id, at, type, status)
-- example_visit.visit(id uuid, patient_id uuid, site_id, reservation_id uuid, date, status)

-- Resolve authoritative current staff scope inside the RPC.
select subject_id, site_id, data_mode
from example_visit.staff_scope
where tenant_id = p_actor->>'tenantId'
  and channel_id = p_actor->>'channelId'
  and group_id = p_actor->>'groupId'
  and manager_id = p_actor->>'managerId'
  and active and can_read_visits;

-- Selected records join that scope and the active patient.
select v.id, v.date, v.reservation_id, v.status
from example_visit.visit v
join example_visit.patient p on p.id = v.patient_id and p.site_id = v.site_id
where p.active and p.id = selected_patient_id and p.site_id = authorized_site_id
  and (selected_visit_id is null or v.id = selected_visit_id)
order by v.date desc, v.id
limit 20;
```

No scope match, out-of-scope selected record, inactive staff or revoked permission must fail closed. Enforce the mapping's dataset and reservation joins too; the example query alone is not the whole implementation. Grant execute only to the deployment's dedicated API credential role and revoke public execution. A security-definer installation function needs a fixed search path, qualified sources and narrow owner privileges. Do not expose generic SQL/service credentials to the agent. The exact installation RPC and grants belong in the private deployment repository.

## Retry and UI state

These synchronous actions are side-effect-free. There are no clinical operation UUIDs, durable receipts, cached snapshots or immutable-snapshot claims. A retry deliberately rereads current authorized context and may return a different observation time or draft. Transport/input failures allow correction or a fresh retry; they do not lock the general AI operation queue.

The WAM keeps a separate request generation. Changing query clears patient/visit/context/fields/draft; changing patient or visit clears confirmation fields and draft. Editing confirmation fields invalidates a pending draft. A response/error only updates its matching generation, so delayed results cannot restore another patient's draft. Fields and draft buttons require an explicitly selected visit. Test results prominently show **가상 테스트 자료 · 실제 환자 정보가 아닙니다.** Data is rendered with DOM text and is never automatically shared with AI.

## Configuration and checks

Supply `VISIT_API` on the Events Worker and the shared `VISIT_SERVICE_TOKEN` secret on both Workers. The visit Worker alone receives `TENANT_ID`, `SUPABASE_URL` and `SUPABASE_API_KEY`; use approved secret-manager/platform secret bindings. Real identifiers, configuration values and clinical evidence belong outside this public repository.

```sh
npm run -w @cf-worker-apps/cloud-agent build:events
npm run -w @cf-worker-apps/cloud-agent build:visit
npm run -w @cf-worker-apps/cloud-agent visit-check
npm run -w @cf-worker-apps/cloud-agent visit-ui-check
```

The native workerd test mocks the fixed RPC and has no Pi Assistant or model accounts. It verifies signed caller/root/group binding, strict shapes, projection, selection/link checks, fresh permission checks, deterministic drafts and bounded errors. DOM checks verify no-account isolation, explicit selection, literal text, correction, stale responses and no Ask sharing. These prove the generic boundary, not production authorization or real clinical semantics. First test an installation with authorized generated records before real-data activation.
