import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));

const channel = "fixture-channel", group = "fixture-group", manager = "fixture-manager", root = "fixture-root", subjectId = "fixture-subject", siteId = "fixture-site";
const ingress = "fixture-ingress-key-at-least-32-different", backend = "fixture-backend-key-at-least-32-different", signing = "ab".repeat(32);
const patientId = "10000000-0000-0000-0000-000000000001", otherId = "10000000-0000-0000-0000-000000000002", visitId = "20000000-0000-0000-0000-000000000001", reservationId = "30000000-0000-0000-0000-000000000001";
const target = { channelId: channel, groupId: group, rootMessageId: root, managerId: manager }, identity = { subjectId, siteId }, search = { action: "patientSearch", query: "Synthetic" };
const fields = { kind: "arrival", concernArea: "Confirmed synthetic area", revision: "no", schedulingExceptions: "None", externalNameChecked: "yes" };
const requests = []; let mode = "normal", observation = 0;
const outbound = async request => {
  assert.equal(request.method, "POST"); assert.equal(request.url, "https://fixture.supabase.invalid/rest/v1/rpc/cloud_agent_visit_read"); assert.equal(request.headers.get("apikey"), "sb_secret_fixture-rpc-credential"); assert.equal(request.headers.get("authorization"), null);
  const value = await request.json(); requests.push(value);
  if (value.p_actor.source === "mcp") assert.deepEqual(value.p_actor, { tenantId: "fixture-tenant", source: "mcp", subjectId, siteId });
  else assert.deepEqual(value.p_actor, value.p_actor.rootMessageId === undefined ? { tenantId: "fixture-tenant", channelId: channel, groupId: group, managerId: manager } : { tenantId: "fixture-tenant", ...target });
  assert.ok(["patientSearch", "visitSelect"].includes(value.p_input.action), "No write, draft or arbitrary SQL RPC reaches Supabase");
  if (mode === "subject-revoked" || mode === "site-revoked") return Response.json({ error: "PRIVATE_DATABASE_DETAILS" }, { status: 403 });
  if (mode === "not-found") return Response.json({ error: "PRIVATE_DATABASE_DETAILS" }, { status: 404 });
  if (mode === "raw-error") return Response.json({ error: "PRIVATE_DATABASE_DETAILS" }, { status: 500 });
  if (mode === "oversize") return new Response("x".repeat(65537));
  if (mode === "malformed") return new Response("not JSON");
  if (value.p_input.action === "patientSearch") return Response.json({ mode: "test", kind: "patients", patients: mode === "too-many" ? Array.from({ length: 21 }, (_, i) => ({ id: "10000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"), label: "Synthetic " + i, reference: null })) : [{ id: patientId, label: "Synthetic <img src=x>", reference: "TEST-001", profile: "PRIVATE_PROFILE" }], notes: "PRIVATE_NOTES" });
  const result = { mode: "test", kind: "context", patient: { id: patientId, label: "Synthetic <img src=x>", reference: null }, reservations: [{ id: reservationId, at: null, type: null, status: null }], visits: [{ id: visitId, date: "2026-01-01", reservationId, status: null }], selectedVisitId: value.p_input.visitId, observedAt: `2026-01-01T00:00:${String(observation++).padStart(2, "0")}Z` };
  if (mode === "cross-patient") result.patient.id = otherId;
  if (mode === "cross-link") result.visits[0].reservationId = otherId;
  return Response.json(result);
};
for (const file of ["gateway.js", "contract.js"]) await writeFile(resolve("build/visit", file), await readFile(resolve("workers/visit", file)));
await writeFile("build/visit/gateway-wrapper.js", `import {handleVisitGateway,readGatewayVisit} from './gateway.js';
export default {async fetch(request,env){const path=new URL(request.url).pathname;if(path==='/fixture/mcp'||path==='/fixture/actor'){try{const value=await request.json();const actor=path==='/fixture/mcp'?{kind:'mcp',identity:{subjectId:env.FIXTURE_SUBJECT_ID,siteId:env.FIXTURE_SITE_ID}}:value.actor;return Response.json(await readGatewayVisit(env,actor,path==='/fixture/mcp'?value:value.input));}catch(error){return Response.json({error:error.message},{status:400});}}return handleVisitGateway(request,env);}};`);
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { name: "events", modulesRoot: resolve("build/events"), modules: [{ type: "ESModule", path: resolve("build/events/index.js") }], compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], kvNamespaces: ["OAUTH_KV"], durableObjects: { EVENTS: { className: "ChannelEvents", useSQLite: true }, THREADS: { className: "ThreadHistory", useSQLite: true } }, serviceBindings: { VISIT_API: "gateway" }, bindings: { PUBLIC_ORIGIN: "https://events.example.invalid", EVENTS_OBJECT_NAME: "fixture-events", OAUTH_OWNER_ID: "fixture-owner", CHANNEL_SLUG: "fixture-slug", CHANNEL_APP_SIGNING_KEY: signing, ALLOWED_CHANNEL_ID: channel, ALLOWED_CHAT_ID: group, CHANNEL_APP_ID: "fixture-app", COMMAND_GROUP_IDS: JSON.stringify([group]), COMMAND_PRIVATE_MANAGERS: "{}", CHANNEL_REPLY_ENABLED: "false", VISIT_SERVICE_TOKEN: ingress }, outboundService() { assert.fail("Events cannot access Supabase, Pi, source APIs or Channel writes"); } },
  { name: "gateway", modulesRoot: resolve("build/visit"), modules: ["gateway-wrapper.js", "gateway.js", "contract.js"].map(file => ({ type: "ESModule", path: resolve("build/visit", file) })), compatibilityDate: "2026-10-01", serviceBindings: { VISIT_API: "backend" }, bindings: { VISIT_SERVICE_TOKEN: backend, VISIT_INGRESS_TOKEN: ingress, FIXTURE_SUBJECT_ID: subjectId, FIXTURE_SITE_ID: siteId }, outboundService() { assert.fail("Gateway has only the fixed private service binding"); } },
  { name: "backend", modulesRoot: resolve("build/visit"), modules: [{ type: "ESModule", path: resolve("build/visit/index.js") }], compatibilityDate: "2026-10-01", bindings: { VISIT_SERVICE_TOKEN: backend, TENANT_ID: "fixture-tenant", SUPABASE_URL: "https://fixture.supabase.invalid", SUPABASE_API_KEY: "sb_secret_fixture-rpc-credential" }, outboundService: outbound }
] }));
async function event(method, params, valid = true, caller = manager) {
  const body = JSON.stringify({ method, params, context: { channel: { id: channel }, caller: { type: "manager", id: caller } } });
  const response = await (await mf.getWorker("events")).fetch("https://events.example.invalid/functions", { method: "PUT", body, headers: { "x-signature": valid ? createHmac("sha256", Buffer.from(signing, "hex")).update(body).digest("base64") : "wrong" } });
  return { status: response.status, ...await response.json() };
}
const readGateway = async (body, token = ingress, path = "/read", method = "POST") => {
  const response = await (await mf.getWorker("gateway")).fetch("https://gateway.internal" + path, { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }), headers: { authorization: "Bearer " + token } });
  return { status: response.status, ...await response.json() };
};
const readBackend = async (body, token = backend) => {
  const response = await (await mf.getWorker("backend")).fetch("https://visit.internal/read", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer " + token } });
  return { status: response.status, ...await response.json() };
};
try {
  assert.match(await (await (await mf.getWorker("events")).fetch("https://events.example.invalid/wam/ai")).text(), /업무 양식/);
  const opened = await event("commands.ai.open", { chat: { type: "group", id: group }, trigger: { attributes: { rootMessageId: root } } });
  const targetCapability = opened.result.attributes.wamArgs.targetCapability, command = input => event("commands.ai.visit", { targetCapability, ...input });
  assert.equal((await event("commands.ai.visit", { targetCapability, ...search }, false)).status, 401);
  assert.equal((await event("commands.ai.visit", { targetCapability, ...search }, true, "another-manager")).error.message, "command_capability_expired_or_mismatched");
  assert.equal((await readGateway({ target, input: search }, backend)).status, 403, "Backend key cannot authenticate Gateway ingress");
  assert.equal((await readGateway({ target, input: search }, "wrong")).status, 403);
  assert.equal((await readBackend({ target, input: search }, ingress)).status, 403, "Ingress key cannot authenticate backend");
  assert.equal((await readGateway({}, ingress, "/other")).status, 404); assert.equal((await readGateway({}, ingress, "/read", "GET")).status, 405);
  const beforeInvalid = requests.length;
  for (const body of [{ identity, input: search }, { target, identity, input: search }, { target, input: search, source: "mcp" }, { target, input: { ...search, identity } }, { input: search }, { target }]) assert.ok((await readGateway(body)).error);
  for (const body of [{ identity: {}, input: search }, { identity: { ...identity, subjectId: "" }, input: search }, { identity: { ...identity, subjectId: "x".repeat(256) }, input: search }, { identity: { ...identity, siteId: "x".repeat(129) }, input: search }, { identity: { ...identity, siteId: "../site" }, input: search }, { identity: { ...identity, role: "admin" }, input: search }, { identity: { ...identity, source: "channel" }, input: search }, { identity, target, input: search }, { identity, tenantId: "spoofed", input: search }, { target: { ...target, identity }, input: search }, { identity, input: { action: "draft", patientId, visitId, fields } }]) assert.ok((await readBackend(body)).error);
  assert.equal(requests.length, beforeInvalid, "Invalid/mixed/spoofed identities have no RPC effects");
  const patients = (await command(search)).result; assert.equal(patients.kind, "patients"); assert.equal(patients.patients[0].id, patientId); assert.ok(!JSON.stringify(patients).includes("PRIVATE")); assert.deepEqual(requests.at(-1).p_actor, { tenantId: "fixture-tenant", ...target });
  const rootless = (await event("commands.ai.open", { chat: { type: "group", id: group } })).result.attributes.wamArgs.targetCapability;
  assert.equal((await event("commands.ai.visit", { targetCapability: rootless, ...search })).result.kind, "patients");
  assert.equal((await event("commands.ai.visit", { targetCapability: rootless, action: "visitSelect", patientId, visitId })).result.selectedVisitId, visitId);
  assert.ok(!Object.hasOwn(requests.at(-1).p_actor, "rootMessageId"));
  mode = "subject-revoked"; assert.equal((await event("commands.ai.visit", { targetCapability: rootless, ...search })).error.message, "visit_record_denied"); mode = "normal";
  for (const rootMessageId of [null, "", "bad/root", 123]) assert.equal((await readGateway({ target: { ...target, rootMessageId }, input: search })).error, "visit_target_invalid");
  const context = (await command({ action: "visitSelect", patientId, visitId })).result; assert.equal(context.selectedVisitId, visitId);
  const draft = (await command({ action: "draft", patientId, visitId, fields })).result; assert.equal(draft.kind, "draft"); assert.equal(draft.draft.ready, true); assert.match(draft.draft.text, /\[상담 도착 안내 초안\]/); assert.equal(requests.at(-1).p_input.action, "visitSelect");
  const treatment = (await command({ action: "draft", patientId, visitId, fields: { ...fields, kind: "treatment", revision: "unknown" } })).result; assert.equal(treatment.draft.ready, false); assert.match(treatment.draft.text, /\[치료실 안내 초안\]/);
  const mcp = input => readGateway(input, ingress, "/fixture/mcp");
  assert.equal((await mcp(search)).kind, "patients"); assert.deepEqual(requests.at(-1).p_actor, { tenantId: "fixture-tenant", source: "mcp", ...identity });
  assert.equal((await mcp({ action: "visitSelect", patientId })).selectedVisitId, null); assert.equal((await mcp({ action: "visitSelect", patientId, visitId })).selectedVisitId, visitId);
  let count = requests.length; assert.equal((await mcp({ action: "draft", patientId, visitId, fields })).error, "visit_input_invalid"); assert.equal((await mcp({ ...search, identity: { subjectId: "spoofed", siteId } })).error, "visit_input_invalid"); assert.equal(requests.length, count);
  for (const actor of [{ kind: "mcp", identity, target }, { kind: "mcp", target }, { kind: "channel", identity, target }, { kind: "mcp", identity: { ...identity, siteId: "bad/site" } }, { kind: "unknown", target }]) assert.ok((await readGateway({ actor, input: search }, ingress, "/fixture/actor")).error);
  count = requests.length; assert.equal((await mcp({ ...search, query: "x".repeat(65) })).error, "visit_input_invalid"); assert.equal(requests.length, count);
  for (mode of ["subject-revoked", "site-revoked"]) { assert.equal((await mcp(search)).error, "visit_record_denied"); assert.equal((await command(search)).error.message, "visit_record_denied"); }
  for (mode of ["cross-patient", "cross-link"]) assert.equal((await mcp({ action: "visitSelect", patientId, visitId })).error, "visit_response_invalid");
  mode = "too-many"; assert.equal((await mcp(search)).error, "visit_response_invalid");
  mode = "oversize"; assert.equal((await mcp(search)).error, "visit_response_too_large"); mode = "malformed"; assert.equal((await mcp(search)).error, "visit_response_invalid");
  mode = "not-found"; assert.equal((await mcp(search)).error, "visit_not_found_for_patient"); mode = "raw-error"; const sanitized = await mcp(search); assert.equal(sanitized.error, "visit_backend_unavailable"); assert.ok(!JSON.stringify(sanitized).includes("PRIVATE"));
  mode = "normal";
  process.stdout.write("Gateway native checks passed: signed WAM/Event → Gateway → backend chain, separate ingress/backend keys, strict Channel/MCP identities, fixed tenant/source, read-only MCP, current revocation checks, projection/bounds/links, unchanged deterministic drafts, no Pi/D1/Channel writes.\n");
} finally { await mf.dispose(); }
