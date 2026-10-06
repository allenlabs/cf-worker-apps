import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { aiPanel } from "../../../mcp-events/workers/api/command-view.js";

const settings = { model: { id: "fixture-model" }, models: [{ id: "fixture-model", label: "기본" }], thinking: { value: "low" }, thinkingChoices: [{ value: "low", label: "낮음" }] };
const calls = [], errors = []; let failOnce = false, rejectOnce = null, rejectDirectOnce = null;
const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
const dom = new JSDOM(aiPanel(), { runScripts: "dangerously", virtualConsole: console, beforeParse(window) {
  window.crypto.randomUUID = randomUUID;
  window.ChannelIOWam = { getWamData: key => ({ appId: "fixture-app", targetCapability: "fixture-capability", rootAvailable: true, rootMessageId: "fixture-root" })[key], setSize: value => assert.equal(value.height, 620), close() {}, async callFunction(input) {
    calls.push(structuredClone(input));
    if (input.params.action !== "help") assert.equal(window.document.getElementById("state").textContent, "요청을 처리하고 있습니다.", "Progress appears before the bridge call");
    if (rejectDirectOnce) { const message = rejectDirectOnce; rejectDirectOnce = null; throw Error(message); }
    if (rejectOnce) { const message = rejectOnce; rejectOnce = null; return { error: { message } }; }
    if (failOnce) { failOnce = false; throw Error("fixture_lost_response"); }
    return { result: input.params.action === "history" ? { status: "done", history: { complete: true, messages: [{ name: "Fixture manager", createdAt: "2026-01-01", text: "<img src=x onerror=alert(1)>" }] } } : { status: "done", message: input.params.action === "ask" ? "fixture answer" : "fixture help", settings, contextSource: input.params.contextSource } };
  } };
} });
const document = dom.window.document, get = id => document.getElementById(id);
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("WAM did not settle"); };
await until(() => get("state").textContent === "완료"); assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
assert.match(get("context").textContent, /명령 요청에서 스레드 원글/);
assert.equal(get("model").value, "fixture-model"); assert.equal(get("thinking").value, "low");
for (const blank of ["", "   \n\t"]) {
  const before = calls.length; get("question").value = blank; document.querySelector('[data-action="ask"]').click();
  assert.equal(calls.length, before, "Blank Ask never calls the bridge"); assert.equal(get("state").textContent, "질문을 입력해 주세요."); assert.equal(document.activeElement, get("question")); assert.equal(get("retry").hidden, true);
  document.querySelector('[data-action="help"]').click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.length, before + 1, "Help works after validation");
}
for (const action of ["history", "model"]) { document.querySelector('[data-action="'+action+'"]').click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.at(-1).params.action, action); }
get("question").value = "Corrected question"; document.querySelector('[data-action="ask"]').click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.at(-1).params.args, "Corrected question");
for (const direct of [false, true]) for (const code of ["command_question_required", "command_argument_invalid", "command_operation_invalid", "command_context_invalid"]) {
  get("question").value = "A valid question"; if (direct) rejectDirectOnce = code; else rejectOnce = code; document.querySelector('[data-action="ask"]').click(); await until(() => get("state").className === "error"); assert.equal(get("retry").hidden, true, "Confirmed invalid input can be corrected"); assert.ok(!get("state").textContent.includes("같은 요청"));
  document.querySelector('[data-action="help"]').click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.at(-1).params.action, "help");
}
get("question").value = "My retained question"; failOnce = true; document.querySelector('[data-action="ask"]').click();
await until(() => !get("retry").hidden); const first = calls.at(-1).params; assert.equal(get("question").value, "My retained question"); get("question").value = "Changed draft";
get("retry").click(); await until(() => get("state").textContent === "완료"); assert.deepEqual(calls.at(-1).params, first, "An unknown response retries the original UUID and original input");
get("share-context").checked = true; get("share-context").dispatchEvent(new dom.window.Event("change")); assert.equal(get("shared-context").disabled, false); get("shared-context").value = "Explicitly shared synthetic context";
document.querySelector('[data-action="ask"]').click(); await until(() => get("answer").textContent.includes("직접 공유")); assert.equal(calls.at(-1).params.contextSource, "shared"); assert.equal(calls.at(-1).params.sharedContext, "Explicitly shared synthetic context");
const presets = [...document.querySelectorAll('[data-prompt]')]; assert.deepEqual(presets.map(button => button.textContent), ["대화 요약", "할 일 정리", "답변 초안"]);
for (const button of presets) {
  const before = calls.length; button.click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).params.action, "ask"); assert.equal(calls.at(-1).params.args, button.dataset.prompt); assert.equal(calls.at(-1).params.contextSource, "shared"); assert.equal(calls.at(-1).params.sharedContext, "Explicitly shared synthetic context");
}
failOnce = true; presets[0].click(); await until(() => !get("retry").hidden); const presetInput = calls.at(-1).params; get("shared-context").value = "Changed draft context"; get("share-context").checked = false; get("retry").click(); await until(() => get("state").textContent === "완료"); assert.deepEqual(calls.at(-1).params, presetInput, "Preset retries preserve prompt, context and UUID");
for (const uncertainCode of ["command_failed", "command_capability_expired_or_mismatched"]) { get("question").value = "Unknown failure"; rejectOnce = uncertainCode; document.querySelector('[data-action="ask"]').click(); await until(() => !get("retry").hidden); const uncertain = calls.at(-1).params, uncertainCount = calls.length; document.querySelector('[data-action="help"]').click(); assert.equal(calls.length, uncertainCount, "Unknown admission state blocks replacement operations"); get("question").value = "Changed unknown draft"; get("retry").click(); await until(() => get("state").textContent === "완료"); assert.deepEqual(calls.at(-1).params, uncertain); }
document.querySelector('[data-action="history"]').click(); await until(() => get("answer").textContent.includes("onerror")); assert.equal(get("answer").querySelector("img"), null, "History is rendered as text, not markup"); assert.match(get("answer").textContent, /조회했습니다\.\n\nFixture manager/);
dom.window.close();
const noRoot = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "fixture", rootAvailable: false })[key], setSize() {}, close() {}, callFunction: async () => ({ result: { status: "done", message: "Start in a thread" } }) }; } });
await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(noRoot.window.document.getElementById("question").disabled, true); assert.equal(noRoot.window.document.querySelector('[data-action="help"]').disabled, false); assert.equal(noRoot.window.document.querySelector('[data-action="history"]').disabled, true); noRoot.window.close();
const hostCalls = [];
const hostOnly = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "group-capability", rootAvailable: false, rootMessageId: "selected-root" })[key], setSize() {}, close() {}, async callFunction(input) { hostCalls.push(structuredClone(input)); return { result: input.name === "commands.ai.bindThread" ? { targetCapability: "thread-capability", rootAvailable: true, rootSource: "wam-selection" } : { status: "done", message: "fixture help", settings } }; } }; } });
await until(() => hostOnly.window.document.getElementById("state").textContent === "완료"); assert.deepEqual(hostCalls.map(call => call.name), ["commands.ai.bindThread", "commands.ai.execute"]); assert.deepEqual(hostCalls[0].params, { targetCapability: "group-capability", rootMessageId: "selected-root" }); assert.equal(hostCalls[1].params.targetCapability, "thread-capability"); assert.equal(hostOnly.window.document.getElementById("question").disabled, false); assert.match(hostOnly.window.document.getElementById("context").textContent, /채널톡 화면에서 선택한 원글/); hostOnly.window.close();
const unavailable = new JSDOM(aiPanel(), { runScripts: "dangerously" }); assert.match(unavailable.window.document.getElementById("context").textContent, /채널톡에서 \/ai/); assert.equal(unavailable.window.document.getElementById("question").disabled, true); unavailable.window.close();
process.stdout.write("WAM UI checks passed: initialization, root badges, read-only missing root, safe text, retained draft, stable retry, explicit shared context, validation recovery, progress and quick actions.\n");
