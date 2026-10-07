import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "pi-visit-mcp-"));
const target = { channelId: "fixture-channel", groupId: "fixture-group", rootMessageId: "fixture-root", managerId: "fixture-manager" };
const operationId = "10000000-0000-0000-0000-000000000001";
const caller = { operationId, sessionId: "1", target };
const input = { action: "patientSearch", query: "Synthetic" };
const ingress = "fixture-ingress-key-at-least-32-characters", backend = "fixture-backend-key-at-least-32-characters";
const actors = [];
const rpc = async request => {
  assert.equal(new URL(request.url).pathname, "/rest/v1/rpc/cloud_agent_visit_read");
  assert.equal(request.headers.get("apikey"), "sb_secret_fixture-credential");
  const { p_actor, p_input } = await request.json(); actors.push(p_actor);
  assert.equal(p_actor.tenantId, "fixture-tenant"); assert.equal(Object.hasOwn(p_actor, "source"), false);
  assert.ok(["patientSearch", "visitSelect"].includes(p_input.action));
  if (new URL(request.url).hostname.startsWith("revoked.")) return Response.json({ error: "PRIVATE_ERROR" }, { status: 403 });
  const mode = new URL(request.url).hostname.startsWith("live.") ? "live" : "test";
  if (p_input.action === "patientSearch") return Response.json({ mode, kind: "patients", patients: [{ id: "10000000-0000-0000-0000-000000000001", label: "Synthetic patient", reference: "TEST-001", privateProfile: "DO_NOT_RETURN" }] });
  return Response.json({ mode, kind: "context", patient: { id: p_input.patientId, label: "Synthetic patient", reference: null }, reservations: [], visits: [], selectedVisitId: null, observedAt: "2026-01-01T00:00:00Z" });
};
let mf;
try {
  for (const name of ["client", "gateway", "backend"]) await build({ entryPoints: [resolve(`tests/workers/pi-mcp/${name}.mjs`)], outfile: join(directory, `${name}.mjs`), bundle: true, platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "client", modules: true, modulesRoot: directory, scriptPath: join(directory, "client.mjs"), compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"], serviceBindings: { VISIT_MCP_API: "gateway" }, bindings: { VISIT_INGRESS_TOKEN: ingress, VISIT_MCP_GROUP_ID: target.groupId, ALLOWED_CHANNEL_ID: target.channelId }, outboundService: () => { throw Error("No external request permitted"); } },
    { name: "gateway", modules: true, modulesRoot: directory, scriptPath: join(directory, "gateway.mjs"), compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"], serviceBindings: { VISIT_API: "backend" }, bindings: { VISIT_INGRESS_TOKEN: ingress, VISIT_SERVICE_TOKEN: backend, VISIT_MCP_GROUP_ID: target.groupId, ALLOWED_CHANNEL_ID: target.channelId } },
    { name: "backend", modules: true, modulesRoot: directory, scriptPath: join(directory, "backend.mjs"), compatibilityDate: "2026-10-04", bindings: { VISIT_SERVICE_TOKEN: backend, TENANT_ID: "fixture-tenant", SUPABASE_API_KEY: "sb_secret_fixture-credential" }, outboundService: rpc }
  ] }));
  const client = await mf.getWorker("client"), gateway = await mf.getWorker("gateway");
  const invoke = async (extra = {}, path = "/invoke") => (await client.fetch("https://fixture.invalid" + path, { method: "POST", body: JSON.stringify({ caller, input, ...extra }) })).json();
  const observed = async () => actors;
  assert.deepEqual(await invoke(), { mode: "test", kind: "patients", patients: [{ id: "10000000-0000-0000-0000-000000000001", label: "Synthetic patient", reference: "TEST-001" }] });
  assert.deepEqual((await observed())[0], { tenantId: "fixture-tenant", ...target }, "Channel caller must reach the fixed RPC unchanged");
  const methods = await (await gateway.fetch("https://fixture.invalid/observed")).json();
  for (const method of ["initialize", "notifications/initialized", "tools/list", "tools/call"]) assert.ok(methods.includes(method), "Missing MCP protocol exchange " + method);
  const second = { ...caller, target: { ...target, managerId: "second-manager" } };
  assert.equal((await invoke({ caller: second })).mode, "test");
  assert.equal((await observed()).at(-1).managerId, "second-manager", "A shared root must retain each caller");
  const context = await invoke({ input: { action: "visitSelect", patientId: "10000000-0000-0000-0000-000000000001" } });
  assert.equal(context.kind, "context"); assert.equal(context.selectedVisitId, null);
  for (const mode of ["live", "non-mcp", "image", "revoked"]) assert.ok((await invoke({ mode })).error, mode + " must be denied");
  const count = (await observed()).length;
  for (const bad of [{ ...target, rootMessageId: undefined }, { ...target, rootMessageId: null }, { ...target, groupId: "other-group" }, { ...target, managerId: undefined }, { ...target, subjectId: "forged-subject" }]) assert.ok((await invoke({ caller: { ...caller, target: bad } })).error);
  assert.ok((await invoke({ env: { VISIT_INGRESS_TOKEN: "wrong-key" } })).error);
  assert.ok((await invoke({ input: { ...input, identity: { subjectId: "forged" } } })).error);
  assert.ok((await invoke({ abort: true })).error);
  assert.equal((await observed()).length, count, "Invalid actors/keys/inputs cannot reach the backend");
  const candidate = { ...caller, state: "running", submission: { id: 9, conversationId: 1, type: "input", status: "placed", requestId: "cmd-" + operationId } };
  assert.deepEqual(await invoke({ candidate }, "/resolve"), caller);
  for (const extra of [{ live: { tools: [{ taskId: 8 }], run: { inputs: [9] } } }, { live: { tools: [{ taskId: 7 }], run: { inputs: [9, 10] } } }, { candidate: { ...candidate, sessionId: "2" } }, { candidate: { ...candidate, submission: { ...candidate.submission, requestId: "manual-prompt" } } }, { candidate: { ...candidate, submission: { ...candidate.submission, status: "done" } } }, { candidate: { ...candidate, state: "done" } }, { memo: second }]) assert.ok((await invoke({ candidate, ...extra }, "/resolve")).error, "Mismatched tool caller must be denied");
  for (const headers of [{ authorization: "Bearer oauth-fixture-token" }, { authorization: "Bearer " + ingress, "x-cloud-agent-visit-target": JSON.stringify({ ...target, identity: { subjectId: "forged" } }) }, { authorization: "Bearer " + ingress, "x-cloud-agent-visit-target": JSON.stringify(target), origin: "https://untrusted.invalid" }]) assert.ok((await gateway.fetch("https://visit.internal/channel-visit/mcp", { method: "POST", headers, body: "{}" })).status >= 400);
  const tools = await invoke({}, "/tools");
  assert.deepEqual(tools.map(tool => tool.name), ["search_visit_patients", "get_visit_context"]);
  assert.ok(tools.every(tool => tool.parameters.additionalProperties === false && !Object.hasOwn(tool.parameters.properties, "target")));
  assert.deepEqual(await invoke({ env: { VISIT_MCP_GROUP_ID: "" } }, "/tools"), []);
  console.log("PASS: real MCP protocol, caller isolation, test-only projection and denied inputs");
} finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
