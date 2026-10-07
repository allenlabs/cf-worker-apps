import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { aiPanel } from "../../../mcp-events/workers/api/command-view.js";

const settings = { model: { id: "fixture-model" }, models: [{ id: "fixture-model", label: "기본" }], thinking: { value: "low" }, thinkingChoices: [{ value: "low", label: "낮음" }] };
const calls = [], errors = []; let failOnce = false, rejectOnce = null, rejectDirectOnce = null;
const image = { status: "ready", assetId: "11111111-1111-4111-8111-111111111111", url: "https://cloud.example.invalid/assets/11111111-1111-4111-8111-111111111111", mediaType: "image/png", bytes: 1234, width: 1536, height: 1024 };
let imageReceipt = { status: "done", image, message: "이미지를 저장했습니다." };
const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
const dom = new JSDOM(aiPanel(), { runScripts: "dangerously", virtualConsole: console, beforeParse(window) {
  window.crypto.randomUUID = randomUUID;
  window.ChannelIOWam = { getWamData: key => ({ appId: "fixture-app", targetCapability: "fixture-capability", rootAvailable: true, rootMessageId: "fixture-root" })[key], setSize: value => { assert.equal(value.width,760,"Host receives the wider composer"); assert.equal(value.height,620); }, close() {}, async callFunction(input) {
    if (input.name === "commands.ai.workflow") return { result: { kind: "catalog", workflows: [] } };
    calls.push(structuredClone(input));
    if (input.params.action !== "help") assert.equal(window.document.getElementById("state").textContent, "요청을 처리하고 있습니다.", "Progress appears before the bridge call");
    if (rejectDirectOnce) { const message = rejectDirectOnce; rejectDirectOnce = null; throw Error(message); }
    if (rejectOnce) { const message = rejectOnce; rejectOnce = null; return { error: { message } }; }
    if (failOnce) { failOnce = false; throw Error("fixture_lost_response"); }
    if (input.params.action === "image") return { result: structuredClone(imageReceipt) };
    return { result: input.params.action === "history" ? { status: "done", history: { complete: true, messages: [{ name: "Fixture manager", createdAt: "2026-01-01", text: "<img src=x onerror=alert(1)>" }] } } : { status: "done", message: input.params.action === "ask" ? "fixture answer" : "fixture help", settings, contextSource: input.params.contextSource } };
  } };
} });
const document = dom.window.document, get = id => document.getElementById(id);
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("WAM did not settle: " + errors.map(error => error.message).join("; ")); };
await until(() => get("state").textContent === "완료"); assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
assert.match(get("context").textContent, /현재 대화에서 업무를 이어갑니다/);
assert.equal(get("model").value, "fixture-model"); assert.equal(get("thinking").value, "low");
for (const blank of ["", "   \n\t"]) {
  const before = calls.length; get("question").value = blank; document.querySelector('[data-action="ask"]').click();
  assert.equal(calls.length, before, "Blank Ask never calls the bridge"); assert.equal(get("state").textContent, "질문을 입력해 주세요."); assert.equal(get("state").hidden,false,"Validation remains visible after a quiet initialization"); assert.equal(document.activeElement, get("question")); assert.equal(get("retry").hidden, true);
  document.querySelector('[data-action="help"]').click(); await until(() => get("state").textContent === "완료"); assert.equal(calls.length, before + 1, "Help works after validation");
}
const imageButton = document.querySelector('[data-action="image"]'); assert.ok(imageButton, "WAM exposes an explicit image action");
get("share-context").checked = true; get("share-context").dispatchEvent(new dom.window.Event("change")); get("shared-context").value = "PRIVATE-SHARED-CONTEXT-MARKER";
for (const blank of ["", "   "] ) {
  const before = calls.length; get("question").value = blank; imageButton.click(); assert.equal(calls.length, before, "Blank image descriptions never call the bridge"); assert.equal(document.activeElement, get("question")); assert.equal(get("retry").hidden, true);
}
get("question").value = "A synthetic teal circle"; failOnce = true; imageButton.click(); await until(() => !get("retry").hidden);
const unknownImage = calls.at(-1).params; assert.equal(unknownImage.action, "image"); assert.equal(unknownImage.args, "A synthetic teal circle"); assert.ok(!Object.hasOwn(unknownImage, "contextSource")); assert.ok(!Object.hasOwn(unknownImage, "sharedContext"), "Images ignore source history and shared context");
get("question").value = "A changed image draft"; get("shared-context").value = "Changed shared context"; get("retry").click(); await until(() => get("state").textContent === "완료"); assert.deepEqual(calls.at(-1).params, unknownImage, "Image retries preserve the original UUID and prompt");
const imageResult = get("image-result"); assert.ok(imageResult); assert.equal(imageResult.hidden, false); assert.match(imageResult.textContent, /1536\s*[×xX]\s*1024/); assert.equal(imageResult.querySelector("img"), null, "SSO assets are separate-tab links, not cross-site img resources");
const imageLink = imageResult.querySelector("a"); assert.ok(imageLink); assert.equal(imageLink.href, image.url); assert.equal(imageLink.target, "_blank"); assert.match(imageLink.rel, /noopener/); assert.match(imageLink.rel, /noreferrer/);
for (const url of ["javascript:alert(1)", "http://cloud.example.invalid/assets/" + image.assetId, "https://user:password@cloud.example.invalid/assets/" + image.assetId, image.url + "?secret=x", image.url + "#secret", "https://cloud.example.invalid/other/" + image.assetId]) {
  imageReceipt = { status: "done", image: { ...image, url } }; imageButton.click(); await until(() => get("state").textContent === "완료"); assert.equal(imageResult.querySelector("a"), null, "Only a clean HTTPS SSO asset path becomes a link"); assert.equal(imageResult.querySelector("img"), null);
}
for (const [status, label] of [["sent", "첨부 완료"], ["disabled", "꺼져 있습니다"], ["unknown", "자동으로 다시 보내지 않습니다"], ["failed", "첨부 결과"]]) {
  imageReceipt = { status: status === "unknown" ? "uncertain" : "done", image, delivery: { status, url: "PRIVATE-TRANSFER-TOKEN" } }; imageButton.click(); await until(() => !imageButton.disabled); assert.match(imageResult.textContent, new RegExp(label)); assert.doesNotMatch(imageResult.textContent, /PRIVATE-TRANSFER/);
}
imageReceipt = { status: "failed", error: "codex_image_http_403", image: { status: "failed", code: "codex_image_http_403", diagnostic: { phase: "image", status: 403, category: "upstream_blocked", contentType: "html", challenge: true, requestId: "fixture-request", rayId: "fixture-ray", body: "<img src=x onerror=alert(1)> PRIVATE-DIAGNOSTIC-BODY", authorization: "PRIVATE-DIAGNOSTIC-AUTH" } } };
imageButton.click(); await until(() => get("state").className === "error"); assert.match(imageResult.textContent, /403/); assert.match(imageResult.textContent, /서비스 접근 차단/); assert.doesNotMatch(imageResult.textContent, /PRIVATE-DIAGNOSTIC|onerror/); assert.equal(imageResult.querySelector("img"), null, "Provider diagnostics are projected text, never HTML");
imageReceipt = { status: "done", image, message: "이미지를 저장했습니다." }; get("share-context").checked = false; get("share-context").dispatchEvent(new dom.window.Event("change"));
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
await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(noRoot.window.document.getElementById("question").disabled, true); assert.equal(noRoot.window.document.querySelector('[data-action="help"]').disabled, false); assert.equal(noRoot.window.document.querySelector('[data-action="history"]').disabled, true); assert.equal(noRoot.window.document.querySelector('[data-action="image"]').disabled, true); noRoot.window.close();
const hostCalls = [];
const hostOnly = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "group-capability", rootAvailable: false, rootMessageId: "selected-root" })[key], setSize() {}, close() {}, async callFunction(input) { if (input.name === "commands.ai.workflow") return { result: { kind: "catalog", workflows: [] } }; hostCalls.push(structuredClone(input)); return { result: input.name === "commands.ai.bindThread" ? { targetCapability: "thread-capability", rootAvailable: true, rootSource: "wam-selection" } : { status: "done", message: "fixture help", settings } }; } }; } });
await until(() => hostOnly.window.document.getElementById("state").textContent === "완료"); assert.deepEqual(hostCalls.map(call => call.name), ["commands.ai.bindThread", "commands.ai.execute"]); assert.deepEqual(hostCalls[0].params, { targetCapability: "group-capability", rootMessageId: "selected-root" }); assert.equal(hostCalls[1].params.targetCapability, "thread-capability"); assert.equal(hostOnly.window.document.getElementById("question").disabled, false); assert.match(hostOnly.window.document.getElementById("context").textContent, /선택한 채널톡 대화에서 업무를 이어갑니다/); hostOnly.window.close();
const unavailable = new JSDOM(aiPanel(), { runScripts: "dangerously" }); assert.match(unavailable.window.document.getElementById("context").textContent, /채널톡에서 \/ai/); assert.equal(unavailable.window.document.getElementById("question").disabled, true); unavailable.window.close();
process.stdout.write("WAM UI checks passed: initialization, root badges, read-only missing root, safe text, retained draft, stable retry, explicit shared context, validation recovery, progress, quick actions, explicit image isolation, image retry, actual dimensions, safe SSO links and projected diagnostics.\n");
