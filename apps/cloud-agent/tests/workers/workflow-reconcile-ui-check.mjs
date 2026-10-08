import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { aiPanel } from "../../../mcp-events/workers/api/command-view.js";

const sourceHash = "b".repeat(64), revision = "a".repeat(64);
const original = "1. POD 1M: Procedure A, Alternate A", reconciled = "1. POD 1M: Alternate A";
const row = { name: "synthetic-reconciliation", revision, definition: { schemaVersion: 1, title: "Synthetic reconciliation", source: "visit-context", fields: [{ id: "person", label: "Person", type: "text", required: true, maxLength: 200, source: "patient.label" }, { id: "pod", label: "POD", type: "text", required: false, maxLength: 1000, source: "performed.pod" }, { id: "note", label: "Note", type: "text", required: false, maxLength: 100 }], template: "{{person}}\n{{pod}}\n{{note}}", confirmations: [{ id: "review", label: "Reviewed" }], reconcile: { field: "pod", source: "performed.activities" } } };
const settings = { models: [{ id: "fixture-model", label: "Fixture model" }], model: { id: "fixture-model" }, thinkingChoices: [{ value: "low", label: "Low" }], thinking: { value: "low" } };
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("Reconciliation UI did not settle"); };
function fixture(mode = "success", root = false, optIn = true) {
  const workflow = structuredClone(row); if (!optIn) delete workflow.definition.reconcile;
  const calls = [], errors = [], vc = new VirtualConsole(); let release;
  vc.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(aiPanel(), { runScripts: "dangerously", virtualConsole: vc, beforeParse(window) {
    window.crypto.randomUUID = randomUUID;
    window.ChannelIOWam = {
      getWamData: key => ({ appId: "fixture-app", targetCapability: "fixture-capability", rootAvailable: root, selectedWorkflow: { name: row.name, revision } })[key], setSize() {}, close() {},
      async callFunction(input) {
        calls.push(structuredClone(input)); const p = input.params;
        if (input.name === "commands.ai.start") return { result: { kind: "start-options", workflows: [workflow], settings } };
        if (input.name === "commands.ai.visit") return { result: p.action === "patientSearch" ? { mode: "live", kind: "patients", patients: [{ id: "fixture-person", label: "Synthetic person", reference: "TEST" }] } : { mode: "live", kind: "context", patient: { id: p.patientId, label: "Synthetic person", reference: "TEST" }, visits: [], reservations: [], selectedVisitId: null } };
        if (input.name !== "commands.ai.workflow") return { result: { status: "done", message: "Ready", settings } };
        if (p.action === "catalog") return { result: { kind: "catalog", workflows: [workflow] } };
        if (p.action === "prefill") return { result: { kind: "prefill", values: { person: "Synthetic person", pod: original, note: "" }, text: "Synthetic person\n" + original, sourceHash, mode: "live" } };
        if (p.action === "reconcile") {
          const result = mode === "failed" ? { error: { message: "workflow_reconcile_unavailable" } } : { result: { kind: "reconciled", name: row.name, revision, values: { ...p.values, pod: reconciled, ...(mode === "malformed" ? { person: "Invented person" } : {}) }, text: "Synthetic person\n" + reconciled, merged: 1, mode: "live" } };
          if (mode === "hold") return new Promise(resolve => { release = () => resolve(result); });
          return result;
        }
        if (p.action === "prepare") return { result: { kind: "draft", operationId: randomUUID(), draftToken: "fixture-draft", text: p.finalText } };
        assert.fail("No delivery expected");
      }
    };
  } });
  const get = id => dom.window.document.getElementById(id), input = (id, value) => { get(id).value = value; get(id).dispatchEvent(new dom.window.Event("input")); };
  return { dom, get, calls, errors, input, held: () => !!release, release: () => release() };
}
async function select(f) {
  await until(() => f.get("workflow-select").options.length === 2);
  if (!f.get("workflow-select").value) { f.get("workflow-select").value = row.name; f.get("workflow-select").dispatchEvent(new f.dom.window.Event("change")); }
  await until(() => !!f.get("workflow-field-pod"));
  await until(() => !f.get("visit-query").disabled);
  f.input("visit-query", "Synthetic"); f.get("visit-search").click();
  await until(() => f.get("visit-patient").options.length === 2);
  f.get("visit-patient").value = "fixture-person";
  f.get("visit-patient").dispatchEvent(new f.dom.window.Event("change"));
}
for (const rooted of [false, true]) {
  const f = fixture("success", rooted); await select(f);
  await until(() => f.get("workflow-field-pod")?.value === reconciled && !f.get("workflow-prepare").disabled);
  assert.equal(f.calls.filter(call => call.params.action === "reconcile").length, 1);
  const request = f.calls.find(call => call.params.action === "reconcile").params;
  assert.deepEqual(request.selection, { patientId: "fixture-person", visitId: null });
  assert.equal(request.sourceHash, sourceHash); assert.equal(request.values.pod, original);
  assert.deepEqual(request.intent, { modelId: "fixture-model", thinkingLevel: "low" });
  assert.equal(f.get("visit-schedule").open, false);
  assert.match(f.get("workflow-state").textContent, /중복 기록 1건/);
  assert.equal(f.get("workflow-check-review").checked, false); assert.equal(f.get("workflow-send").disabled, true);
  assert.equal(f.calls.filter(call => ["create", "ask", "send"].includes(call.params.action)).length, 0);
  f.get("workflow-prepare").click(); await until(() => !f.get("workflow-checks").disabled);
  assert.equal(f.get("workflow-check-review").checked, false); assert.equal(f.get("workflow-send").disabled, true);
  assert.equal(f.errors.length, 0); f.dom.window.close();
}
for (const mode of ["failed", "malformed"]) {
  const f = fixture(mode); await select(f); await until(() => f.get("workflow-state").className === "error" && !f.get("workflow-prepare").disabled);
  assert.equal(f.get("workflow-field-pod").value, original); assert.equal(f.get("workflow-draft").value, "Synthetic person\n" + original);
  assert.match(f.get("workflow-state").textContent, /원본 POD를 유지/);
  assert.equal(f.calls.filter(call => call.params.action === "reconcile").length, 1, "Failure never retries automatically");
  assert.equal(f.get("workflow-field-person").value, "Synthetic person"); assert.equal(f.errors.length, 0); f.dom.window.close();
}
const stale = fixture("hold"); await select(stale); await until(stale.held);
assert.equal(stale.get("workflow-field-pod").value, original, "Original remains visible during inference");
stale.input("workflow-draft", "Staff edited body"); stale.release(); await until(() => !stale.get("visit-patient").disabled);
assert.equal(stale.get("workflow-draft").value, "Staff edited body"); assert.equal(stale.get("workflow-field-pod").value, original);
assert.equal(stale.get("workflow-send").disabled, true); assert.equal(stale.errors.length, 0); stale.dom.window.close();
const ordinary = fixture("success", false, false); await select(ordinary); await until(() => !ordinary.get("workflow-prepare").disabled);
assert.equal(ordinary.calls.filter(call => call.params.action === "reconcile").length, 0, "Existing definitions do not invoke a model"); assert.equal(ordinary.get("workflow-field-pod").value, original); ordinary.dom.window.close();
console.log("Workflow reconciliation WAM checks passed: patient-only automatic opt-in, source/model pinning, raw fallback, stale-edit preservation, no automatic retry, unchecked review and no native messages.");
