import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { aiPanel } from "../../../mcp-events/workers/api/command-view.js";

const patientId = "10000000-0000-0000-0000-000000000001", otherId = "10000000-0000-0000-0000-000000000002", visitId = "20000000-0000-0000-0000-000000000001";
const calls = [], errors = []; let rejection = null, holdNext = false, release = null, count = 0;
const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
const dom = new JSDOM(aiPanel(), { runScripts: "dangerously", virtualConsole: console, beforeParse(window) {
  window.crypto.randomUUID = randomUUID;
  window.ChannelIOWam = { getWamData: key => ({ appId: "fixture-app", targetCapability: "fixture-capability", rootAvailable: true })[key], setSize() {}, close() {}, async callFunction(input) {
    calls.push(structuredClone(input));
    if (input.name === "commands.ai.execute") return { error: { message: "command_assistant_unavailable" } };
    assert.equal(input.name, "commands.ai.visit"); assert.equal(input.params.targetCapability, "fixture-capability"); assert.ok(!("operationId" in input.params), "Read-only operations do not claim durable snapshot replay");
    assert.equal(window.document.getElementById("visit-state").textContent, input.params.action === "draft" ? "초안을 만들고 있습니다." : "자료를 조회하고 있습니다.");
    if (rejection) { const error = rejection; rejection = null; if (error === "transport") throw Error("lost-response"); return { error: { message: error } }; }
    const result = input.params.action === "patientSearch" ? { mode: "test", kind: "patients", patients: [{ id: patientId, label: "Synthetic <img src=x onerror=alert(1)>", reference: "TEST-001" }, { id: otherId, label: "Other synthetic", reference: "TEST-002" }] } : input.params.action === "visitSelect" ? { mode: "test", kind: "context", patient: { id: input.params.patientId, label: "Synthetic <img src=x>", reference: null }, reservations: [], visits: [{ id: visitId, date: "2026-01-01", reservationId: null, status: "arrived" }], selectedVisitId: input.params.visitId ?? null, observedAt: "2026-01-01T00:00:00Z" } : { mode: "test", kind: "draft", draft: { text: "Synthetic draft <img src=x onerror=alert(1)> " + (++count), missingFields: [], ready: true }, observedAt: "2026-01-01T00:00:00Z" };
    if (holdNext) { holdNext = false; return new Promise(resolve => { release = () => resolve({ result }); }); }
    return { result };
  } };
} });
const document = dom.window.document, get = id => document.getElementById(id);
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("Visit WAM did not settle"); };
const input = (id, value) => { get(id).value = value; get(id).dispatchEvent(new dom.window.Event("input")); };
const change = (id, value) => { get(id).value = value; get(id).dispatchEvent(new dom.window.Event("change")); };
const search = async () => { input("visit-query", "Synthetic"); get("visit-search").click(); await until(() => get("visit-patient").options.length === 3); };
try {
  await until(() => get("state").className === "error"); assert.equal(get("visit-query").disabled, false, "Visit workflow remains usable when initial model Help fails without accounts"); assert.equal(get("visit-search").disabled, true);
  input("visit-query", "x"); assert.equal(get("visit-search").disabled, true); await search(); assert.match(get("visit-mode").textContent, /가상 테스트 자료/); assert.equal(get("visit-patient").value, ""); assert.equal(get("visit-patient").querySelector("img"), null); assert.equal(get("visit-arrival").disabled, true);
  change("visit-patient", patientId); await until(() => get("visit-select").options.length === 2); assert.equal(calls.at(-1).params.visitId, null); assert.equal(get("visit-select").value, ""); assert.equal(get("visit-arrival").disabled, true, "Visit selection is explicit");
  change("visit-select", visitId); await until(() => !get("visit-fields").disabled); input("visit-concern", "Confirmed synthetic area"); input("visit-revision", "no"); input("visit-exceptions", "None"); input("visit-name-check", "yes"); get("visit-arrival").click(); await until(() => get("visit-draft").textContent.includes("draft")); assert.equal(calls.at(-1).params.fields.kind, "arrival"); assert.equal(get("visit-draft").querySelector("img"), null); assert.equal(get("question").value, ""); assert.equal(get("shared-context").value, "", "Visit context never leaks into general Ask");
  const first = get("visit-draft").textContent; get("visit-treatment").click(); await until(() => get("visit-draft").textContent !== first); assert.equal(calls.at(-1).params.fields.kind, "treatment");
  input("visit-concern", "Changed confirmation"); assert.equal(get("visit-draft").textContent, "");
  for (const error of ["visit_input_invalid", "visit_record_denied", "visit_not_found_for_patient", "transport"]) {
    rejection = error; get("visit-arrival").click(); await until(() => get("visit-state").className === "error"); assert.equal(get("visit-arrival").disabled, false, "Read-only errors unlock correction and fresh retry"); get("visit-arrival").click(); await until(() => get("visit-draft").textContent.includes("draft"));
  }
  holdNext = true; get("visit-arrival").click(); await until(() => release !== null); input("visit-query", "Other"); assert.equal(get("visit-patient").options.length, 1); assert.equal(get("visit-context").textContent, ""); assert.equal(get("visit-draft").textContent, ""); assert.equal(get("visit-fields").disabled, true); release(); release = null; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(get("visit-draft").textContent, "", "A stale draft cannot reappear after query change");
  await search(); holdNext = true; change("visit-patient", patientId); await until(() => release !== null); change("visit-patient", otherId); await until(() => get("visit-context").textContent.includes("Synthetic")); const latest = get("visit-context").textContent; release(); release = null; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(get("visit-patient").value, otherId); assert.equal(get("visit-context").textContent, latest, "A stale context cannot replace a later selected patient");
  change("visit-select", visitId); await until(() => !get("visit-fields").disabled); assert.equal(get("visit-concern").value, "", "Patient/visit changes discard previous confirmation fields");
  assert.equal(calls.filter(value => value.name !== "commands.ai.visit").length, 1, "Only the unchanged initial AI Help runs; clinical clicks never invoke general AI"); assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
} finally { dom.window.close(); }
const noRoot = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "fixture", rootAvailable: false })[key], setSize() {}, close() {}, callFunction: async () => ({ result: { status: "done", message: "Start in a thread" } }) }; } });
await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(noRoot.window.document.getElementById("visit-query").disabled, true); assert.equal(noRoot.window.document.getElementById("visit-search").disabled, true); noRoot.window.close();
process.stdout.write("Visit WAM checks passed: no-account Help isolation, explicit patient/visit selection, test badge, literal draft text, no Ask sharing, correction/fresh retry, query/patient/visit invalidation, stale response suppression and missing-root controls.\n");
