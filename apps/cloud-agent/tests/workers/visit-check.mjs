import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import "./visit-contract-check.mjs";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));

const channel = "fixture-channel", group = "fixture-group", manager = "fixture-manager", root = "fixture-root", signing = "ab".repeat(32), token = "fixture-visit-service-token-at-least-32", key = "sb_secret_fixture-dedicated-rpc-key";
const patientId = "10000000-0000-0000-0000-000000000001", otherId = "10000000-0000-0000-0000-000000000002", visitId = "20000000-0000-0000-0000-000000000001", reservationId = "30000000-0000-0000-0000-000000000001";
const performed = { procedureText: "Synthetic procedure A (2025-12-25)\nSynthetic procedure A (2025-12-29)", pod: "Synthetic procedure A (2025-12-25): POD 7\nSynthetic procedure A (2025-12-29): POD 3" };
performed.activities = [{ id: "40000000-0000-4000-8000-000000000001", performedOn: "2025-12-25", podLabel: "7D", types: ["Synthetic procedure A"], fkCount: 3, reservationId, parentId: null }];
performed.menu = [{ abbreviation: "Synthetic procedure A", name: "Synthetic procedure", location: null, surgeryName: null, product: null, isSurgery: true }];
const requests = []; let mode = "normal", observed = 0, activeKey = key, performedOverride;
const outbound = async request => {
  assert.equal(request.url, "https://fixture.supabase.invalid/rest/v1/rpc/cloud_agent_visit_read"); assert.equal(request.method, "POST");
  assert.equal(request.headers.get("apikey"), activeKey); assert.equal(request.headers.get("authorization"), activeKey.startsWith("eyJ") ? "Bearer " + activeKey : null, "Only legacy JWT keys receive a Bearer header");
  const body = await request.json(); requests.push(body); assert.deepEqual(body.p_actor, { tenantId: "fixture-tenant", channelId: channel, groupId: group, ...(body.p_actor.rootMessageId === undefined ? {} : { rootMessageId: root }), managerId: manager });
  assert.deepEqual(Object.keys(body), ["p_actor", "p_input"]); assert.ok(["patientSearch", "visitSelect"].includes(body.p_input.action), "No SQL selectors or write RPCs reach the backend");
  if (mode === "denied") return Response.json({ details: "PRIVATE_BACKEND_ERROR" }, { status: 403 });
  if (mode === "not-found") return Response.json({ details: "PRIVATE_BACKEND_ERROR" }, { status: 404 });
  if (mode === "redirect") return new Response("", { status: 302, headers: { location: "https://leak.invalid" } });
  if (mode === "oversize") return new Response("x".repeat(65537));
  if (mode === "malformed") return new Response("{bad");
  if (mode === "boundary" && body.p_input.action === "patientSearch") return Response.json({ mode: "test", kind: "patients", patients: Array.from({ length: 20 }, (_, i) => ({ id: "10000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"), label: "Synthetic " + i, reference: null })) });
  if (mode === "search-too-many") return Response.json({ mode: "test", kind: "patients", patients: Array.from({ length: 21 }, (_, i) => ({ id: "10000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"), label: "Synthetic " + i, reference: null })) });
  if (body.p_input.action === "patientSearch") return Response.json({ mode: "test", kind: "patients", patients: mode === "empty" ? [] : [{ id: patientId, label: "Synthetic person <img src=x>", reference: "TEST-001", email: "must-not-return@example.invalid", chart: "FORBIDDEN_PROFILE" }, ...(mode === "duplicate" ? [{ id: patientId, label: "Duplicate", reference: null }] : [])], clinicalNotes: "FORBIDDEN_NOTES" });
  const value = { mode: "test", kind: "context", patient: { id: patientId, label: "Synthetic person <img src=x>", reference: "TEST-001", phone: "FORBIDDEN_PHONE" }, reservations: [{ id: reservationId, at: "2026-01-01T10:00:00Z", type: "consultation", status: "confirmed", procedureText: "Synthetic selected candidate", note: "Synthetic selected note", pod: "POD 3", profile: "FORBIDDEN_PROFILE" }, { id: "30000000-0000-0000-0000-000000000002", at: null, type: null, status: null, procedureText: "FORBIDDEN_UNLINKED_CANDIDATE", note: "FORBIDDEN_UNLINKED_NOTE", pod: "FORBIDDEN_UNLINKED_POD" }], visits: [{ id: visitId, date: "2026-01-01", reservationId, status: "arrived" }], selectedVisitId: body.p_input.visitId, intake: { concernText: "Synthetic intake concern", hidden: "FORBIDDEN_INTAKE" }, observedAt: `2026-01-01T10:00:${String(observed++).padStart(2, "0")}Z`, hidden: "FORBIDDEN_NOTES" };
  value.performed = { ...performed, hidden: "FORBIDDEN_PERFORMED", activities: performed.activities.map(row => ({ ...row, hidden: "FORBIDDEN_PERFORMED" })), menu: performed.menu.map(row => ({ ...row, hidden: "FORBIDDEN_PERFORMED" })) };
  if (mode === "boundary") {
    value.reservations = Array.from({ length: 20 }, (_, i) => ({ ...value.reservations[0], id: "30000000-0000-0000-0000-" + String(i + 1).padStart(12, "0") }));
    value.visits = Array.from({ length: 20 }, (_, i) => ({ ...value.visits[0], id: "20000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"), reservationId: i ? null : reservationId }));
  }
  if (mode === "reservations-too-many") value.reservations = Array.from({ length: 21 }, (_, i) => ({ ...value.reservations[0], id: "30000000-0000-0000-0000-" + String(i + 1).padStart(12, "0") }));
  if (mode === "missing-candidates") { delete value.intake; delete value.performed; delete value.reservations[0].pod; }
  if (mode === "null-candidates") { value.intake.concernText = null; value.performed = { procedureText: null, pod: null }; value.reservations[0].pod = null; }
  if (mode === "candidate-boundary") { value.intake.concernText = "x".repeat(1000); value.performed = { procedureText: "x".repeat(1000), pod: "😀".repeat(500) }; value.reservations[0].pod = "x".repeat(40); }
  if (mode === "invalid-performed") value.performed = performedOverride;
  if (mode === "long-concern") value.intake.concernText = "x".repeat(1001);
  if (mode === "invalid-intake") value.intake = null;
  if (mode === "missing-concern") value.intake = {};
  if (mode === "null-byte-concern") value.intake.concernText = "A\0B";
  if (mode === "long-pod") value.reservations[0].pod = "x".repeat(41);
  if (mode === "invalid-pod") value.reservations[0].pod = 3;
  if (mode === "null-byte-pod") value.reservations[0].pod = "A\0B";
  if (mode === "missing-visit") value.visits = [];
  if (mode === "wrong-patient") value.patient.id = otherId;
  if (mode === "wrong-visit") value.selectedVisitId = otherId;
  if (mode === "wrong-relationship") value.visits[0].reservationId = otherId;
  if (mode === "wrong-id") value.visits[0].id = "not-a-uuid";
  if (mode === "too-many") value.visits = Array(21).fill(value.visits[0]);
  if (mode === "wrong-date") value.observedAt = "tomorrow";
  if (mode === "wrong-mode") value.mode = "client-selected";
  return Response.json(value);
};
const options = (overrides = {}) => convertV4MiniflareOptions({ workers: [
  { name: "events", modulesRoot: resolve("build/events"), modules: [{ type: "ESModule", path: resolve("build/events/index.js") }], compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], kvNamespaces: ["OAUTH_KV"], durableObjects: { EVENTS: { className: "ChannelEvents", useSQLite: true }, THREADS: { className: "ThreadHistory", useSQLite: true } }, serviceBindings: { VISIT_API: "visit" }, bindings: { PUBLIC_ORIGIN: "https://events.example.invalid", EVENTS_OBJECT_NAME: "fixture-events", OAUTH_OWNER_ID: "fixture-owner", CHANNEL_SLUG: "fixture-channel", CHANNEL_APP_SIGNING_KEY: signing, ALLOWED_CHANNEL_ID: channel, ALLOWED_CHAT_ID: group, CHANNEL_APP_ID: "fixture-app", COMMAND_GROUP_IDS: JSON.stringify([group]), COMMAND_PRIVATE_MANAGERS: "{}", CHANNEL_REPLY_ENABLED: "false", VISIT_SERVICE_TOKEN: token, ...overrides }, outboundService() { assert.fail("Events must use the fixed visit binding; no Pi, source API, D1 or Channel call"); } },
  { name: "visit", modulesRoot: resolve("build/visit"), modules: [{ type: "ESModule", path: resolve("build/visit/index.js") }], compatibilityDate: "2026-10-01", bindings: { TENANT_ID: "fixture-tenant", VISIT_SERVICE_TOKEN: token, SUPABASE_URL: "https://fixture.supabase.invalid", SUPABASE_API_KEY: activeKey }, outboundService: outbound }
] });
let mf = new Miniflare(options());
const envelope = (method, params, caller = manager) => ({ method, params, context: { channel: { id: channel }, caller: { type: "manager", id: caller } } });
async function call(input, signed = true) {
  const body = JSON.stringify(input), response = await (await mf.getWorker("events")).fetch("https://events.example.invalid/functions", { method: "PUT", headers: { "x-signature": signed ? createHmac("sha256", Buffer.from(signing, "hex")).update(body).digest("base64") : "wrong" }, body });
  return { status: response.status, ...await response.json() };
}
const capability = async (bound = true) => (await call(envelope("commands.ai.open", { chat: { type: "group", id: group }, ...(bound ? { trigger: { attributes: { rootMessageId: root } } } : {}) }))).result.attributes.wamArgs.targetCapability;
const fields = { kind: "arrival", concernArea: "Confirmed synthetic area", revision: "no", schedulingExceptions: "None", externalNameChecked: "yes" };
try {
  const discovery = await call(envelope("extension.core.function.getFunctions", {})); assert.ok(discovery.result.functions.some(value => value.name === "commands.ai.visit"));
  const targetCapability = await capability(), request = input => call(envelope("commands.ai.visit", { targetCapability, ...input }));
  const search = { action: "patientSearch", query: "Synthetic" };
  const expiredTarget = JSON.parse(Buffer.from(targetCapability.split(".")[0], "base64url").toString()); expiredTarget.expiresAt = Date.now() - 1;
  const expiredPayload = Buffer.from(JSON.stringify(expiredTarget)).toString("base64url"), expired = expiredPayload + "." + createHmac("sha256", Buffer.from(signing, "hex")).update("channel-command-target/v1:" + expiredPayload).digest("base64url");
  assert.equal((await call(envelope("commands.ai.visit", { targetCapability: expired, ...search }))).error.message, "command_capability_expired_or_mismatched");
  assert.equal((await call(envelope("commands.ai.visit", { targetCapability, ...search }), false)).status, 401); assert.equal(requests.length, 0);
  assert.equal((await call(envelope("commands.ai.visit", { targetCapability, ...search }, "another-manager"))).error.message, "command_capability_expired_or_mismatched");
  const groupCapability = await capability(false);
  assert.equal((await call(envelope("commands.ai.visit", { targetCapability: groupCapability, ...search }))).result.kind, "patients");
  assert.ok(!Object.hasOwn(requests.at(-1).p_actor, "rootMessageId"));
  assert.equal((await call(envelope("commands.ai.visit", { targetCapability: groupCapability, action: "draft", patientId, visitId, fields }))).error.message, "command_thread_required");
  for (const input of [{ ...search, subjectId: "untrusted" }, { ...search, dataset: "live" }, { ...search, query: "x" }, { ...search, query: "x".repeat(65) }, { ...search, query: "A\0B" }, { action: "visitSelect", patientId: "not-a-uuid" }, { action: "draft", patientId, fields }, { action: "draft", patientId, visitId, fields: { ...fields, prompt: "untrusted" } }, { action: "draft", patientId, visitId, fields: { ...fields, concernArea: "x".repeat(201) } }]) assert.match((await request(input)).error.message, /^visit_(input_invalid|selection_required)$/);
  assert.equal(requests.length, 1, "Only the authorized rootless read reaches the backend");
  assert.equal((await request({ ...search, query: "x".repeat(64) })).result.kind, "patients", "64-character normalized query is supported");
  const patients = (await request(search)).result; assert.equal(patients.mode, "test"); assert.deepEqual(patients.patients[0], { id: patientId, label: "Synthetic person <img src=x>", reference: "TEST-001" }); assert.ok(!JSON.stringify(patients).includes("FORBIDDEN"));
  mode = "empty"; assert.deepEqual((await request(search)).result.patients, []); mode = "duplicate"; assert.equal((await request(search)).error.message, "visit_response_invalid"); mode = "normal";
  const select = { action: "visitSelect", patientId };
  const context = (await request(select)).result; assert.equal(context.selectedVisitId, null, "There is no implicit latest visit selection"); assert.ok(!JSON.stringify(context).includes("FORBIDDEN")); assert.equal(requests.at(-1).p_input.visitId, null); assert.deepEqual(context.intake, { concernText: "Synthetic intake concern" }, "Authorized patient intake is available without a schedule"); assert.ok(context.reservations.every(row => !Object.hasOwn(row, "pod") && !Object.hasOwn(row, "note") && !Object.hasOwn(row, "procedureText")), "Unselected context exposes no candidate content");
  assert.deepEqual(context.performed, performed, "Patient-level performed episodes survive projection without a selected visit, including both labelled POD lines");
  mode = "boundary"; assert.equal((await request(search)).result.patients.length, 20); const boundary = (await request({ ...select, visitId })).result; assert.equal(boundary.visits.length, 20); assert.equal(boundary.reservations.length, 20); assert.equal(boundary.visits[1].reservationId, null, "An unavailable projected reservation link remains unresolved");
  mode = "search-too-many"; assert.equal((await request(search)).error.message, "visit_response_invalid"); mode = "normal";
  const selected = (await request({ ...select, visitId })).result; assert.equal(selected.selectedVisitId, visitId); assert.equal(selected.reservations[0].procedureText, "Synthetic selected candidate"); assert.equal(selected.reservations[0].note, "Synthetic selected note"); assert.ok(!Object.hasOwn(selected.reservations[1], "procedureText") && !Object.hasOwn(selected.reservations[1], "note"), "Candidates are projected only on the explicitly selected visit linked reservation");
  assert.equal(selected.reservations[0].pod, "POD 3"); assert.ok(!Object.hasOwn(selected.reservations[1], "pod")); assert.deepEqual(selected.intake, { concernText: "Synthetic intake concern" }); assert.ok(!JSON.stringify(selected).includes("FORBIDDEN"));
  assert.deepEqual(selected.performed, performed, "Selecting a visit does not scope performed summaries to its reservation");
  mode = "missing-candidates"; const older = (await request({ ...select, visitId })).result; assert.ok(!Object.hasOwn(older, "intake") && !Object.hasOwn(older, "performed") && !Object.hasOwn(older.reservations[0], "pod"), "Older backends may omit new candidates");
  mode = "null-candidates"; const unknown = (await request({ ...select, visitId })).result; assert.deepEqual(unknown.intake, { concernText: null }); assert.deepEqual(unknown.performed, { procedureText: null, pod: null }); assert.equal(unknown.reservations[0].pod, null);
  mode = "candidate-boundary"; const bounded = (await request({ ...select, visitId })).result; assert.equal(bounded.intake.concernText.length, 1000); assert.equal(bounded.reservations[0].pod.length, 40); assert.deepEqual(bounded.performed, { procedureText: "x".repeat(1000), pod: "😀".repeat(500) }, "Both performed summaries accept exactly 1,000 UTF-16 code units");
  for (mode of ["long-concern", "invalid-intake", "missing-concern", "null-byte-concern", "long-pod", "invalid-pod", "null-byte-pod"]) { assert.equal((await request({ ...select, visitId })).error.message, "visit_response_invalid", mode); if (["long-concern", "invalid-intake", "missing-concern", "null-byte-concern"].includes(mode)) assert.equal((await request(select)).error.message, "visit_response_invalid", "Patient-level intake is validated without a schedule"); else { const unselected = (await request(select)).result; assert.deepEqual(unselected.intake, { concernText: "Synthetic intake concern" }); assert.ok(unselected.reservations.every(row => !Object.hasOwn(row, "pod")), "Unselected reservation candidates are discarded"); } }
  mode = "invalid-performed";
  for (performedOverride of [null, [], {}, { procedureText: null }, { pod: null }, { procedureText: 3, pod: null }, { procedureText: null, pod: [] }, { procedureText: "A\0B", pod: null }, { procedureText: null, pod: "A\0B" }, { procedureText: "x".repeat(1001), pod: null }, { procedureText: null, pod: "x".repeat(1001) }, { procedureText: null, pod: "😀".repeat(501) }]) {
    for (const selectedVisitId of [null, visitId]) assert.equal((await request({ ...select, visitId: selectedVisitId })).error.message, "visit_response_invalid", "Malformed or oversized performed summaries fail with and without a selected visit");
  }
  mode = "normal";
  const draftInput = { action: "draft", patientId, visitId, fields };
  const draft = (await request(draftInput)).result; assert.equal(draft.draft.ready, true); assert.deepEqual(draft.draft.missingFields, []); assert.match(draft.draft.text, /가상 테스트 자료/); assert.match(draft.draft.text, /\[상담 도착 안내 초안\]/); assert.match(draft.draft.text, /재수술 여부: 아니요/); assert.deepEqual(requests.at(-1).p_input, { action: "visitSelect", patientId, visitId }, "Draft performs an authorized fresh read, not a cached client snapshot");
  const retry = (await request(draftInput)).result; assert.notEqual(retry.observedAt, draft.observedAt, "Read-only retries deliberately observe current context");
  const missing = (await request({ ...draftInput, fields: { kind: "treatment", concernArea: "", revision: "unknown", schedulingExceptions: "", externalNameChecked: "no" } })).result; assert.equal(missing.draft.ready, false); assert.deepEqual(missing.draft.missingFields, ["concernArea", "revision", "schedulingExceptions", "externalNameChecked"]); assert.match(missing.draft.text, /\[치료실 안내 초안\]/); assert.match(missing.draft.text, /미입력/);
  for (mode of ["wrong-patient", "wrong-visit", "missing-visit", "wrong-relationship", "wrong-id", "too-many", "reservations-too-many", "wrong-date", "wrong-mode", "malformed"]) assert.equal((await request({ ...select, visitId })).error.message, "visit_response_invalid", mode);
  mode = "oversize"; assert.equal((await request(search)).error.message, "visit_response_too_large");
  mode = "denied"; assert.equal((await request(draftInput)).error.message, "visit_record_denied", "Permission revocation is checked again for every draft");
  mode = "not-found"; assert.equal((await request(draftInput)).error.message, "visit_not_found_for_patient");
  mode = "redirect"; assert.equal((await request(search)).error.message, "visit_backend_unavailable"); mode = "normal";
  const service = await mf.getWorker("visit"); assert.equal((await service.fetch("https://visit.internal/read", { method: "POST", body: "{}" })).status, 403);
  const direct = body => service.fetch("https://visit.internal/read", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(body) });
  assert.equal((await (await direct({ target: { channelId: channel, groupId: group, rootMessageId: root, managerId: manager, subjectId: "untrusted" }, input: search })).json()).error, "visit_target_invalid");
  assert.equal((await (await direct({ target: { channelId: channel, groupId: group, rootMessageId: root, managerId: manager }, input: search, sql: "untrusted" })).json()).error, "visit_input_invalid");
  activeKey = "eyJ-fixture-legacy-jwt-at-least-16"; await mf.setOptions(options()); assert.equal((await request(search)).result.kind, "patients", "Legacy key keeps its documented JWT bearer header"); activeKey = key;
  await mf.setOptions(options({ COMMAND_GROUP_IDS: "[]" })); assert.equal((await request(search)).error.message, "command_target_denied", "Revoked group policy is checked on every call");
  await mf.setOptions(options({ VISIT_SERVICE_TOKEN: "wrong" })); assert.equal((await request(search)).error.message, "visit_not_configured");
  process.stdout.write("Visit native checks passed: signed binding/caller/root/policy, strict read DTOs, projection, explicit selection, fresh permission-checked deterministic drafts, bounded responses, no model accounts/Pi/Channel/database writes.\n");
} finally { await mf.dispose(); }
