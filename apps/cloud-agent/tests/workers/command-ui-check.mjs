import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { aiPanel } from "../../../mcp-events/workers/api/command-view.js";

const settings = { model: { id: "fixture-model" }, models: [{ id: "fixture-model", label: "기본" }], thinking: { value: "low" }, thinkingChoices: [{ value: "low", label: "낮음" }] };
const calls = [], errors = []; let failOnce = false;
const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
const dom = new JSDOM(aiPanel(), { runScripts: "dangerously", virtualConsole: console, beforeParse(window) {
  window.crypto.randomUUID = randomUUID;
  window.ChannelIOWam = { getWamData: key => ({ appId: "fixture-app", targetCapability: "fixture-capability", rootAvailable: true, rootMessageId: "fixture-root" })[key], setSize: value => assert.equal(value.height, 620), close() {}, async callFunction(input) {
    calls.push(structuredClone(input));
    if (failOnce) { failOnce = false; throw Error("fixture_lost_response"); }
    return { result: input.params.action === "history" ? { status: "done", history: { complete: true, messages: [{ name: "Fixture manager", createdAt: "2026-01-01", text: "<img src=x onerror=alert(1)>" }] } } : { status: "done", message: input.params.action === "ask" ? "fixture answer" : "fixture help", settings, contextSource: input.params.contextSource } };
  } };
} });
const document = dom.window.document, get = id => document.getElementById(id);
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("WAM did not settle"); };
await until(() => get("state").textContent === "완료"); assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
assert.match(get("context").textContent, /명령 요청에서 스레드 원글/);
assert.equal(get("model").value, "fixture-model"); assert.equal(get("thinking").value, "low");
get("question").value = "My retained question"; failOnce = true; document.querySelector('[data-action="ask"]').click();
await until(() => !get("retry").hidden); const first = calls.at(-1).params; assert.equal(get("question").value, "My retained question"); get("question").value = "Changed draft";
get("retry").click(); await until(() => get("state").textContent === "완료"); assert.deepEqual(calls.at(-1).params, first, "An unknown response retries the original UUID and original input");
get("share-context").checked = true; get("share-context").dispatchEvent(new dom.window.Event("change")); assert.equal(get("shared-context").disabled, false); get("shared-context").value = "Explicitly shared synthetic context";
document.querySelector('[data-action="ask"]').click(); await until(() => get("answer").textContent.includes("직접 공유")); assert.equal(calls.at(-1).params.contextSource, "shared"); assert.equal(calls.at(-1).params.sharedContext, "Explicitly shared synthetic context");
document.querySelector('[data-action="history"]').click(); await until(() => get("answer").textContent.includes("onerror")); assert.equal(get("answer").querySelector("img"), null, "History is rendered as text, not markup"); assert.match(get("answer").textContent, /조회했습니다\.\n\nFixture manager/);
dom.window.close();
const noRoot = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "fixture", rootAvailable: false })[key], setSize() {}, close() {}, callFunction: async () => ({ result: { status: "done", message: "Start in a thread" } }) }; } });
await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(noRoot.window.document.getElementById("question").disabled, true); assert.equal(noRoot.window.document.querySelector('[data-action="help"]').disabled, false); assert.equal(noRoot.window.document.querySelector('[data-action="history"]').disabled, true); noRoot.window.close();
const hostCalls = [];
const hostOnly = new JSDOM(aiPanel(), { runScripts: "dangerously", beforeParse(window) { window.crypto.randomUUID = randomUUID; window.ChannelIOWam = { getWamData: key => ({ appId: "fixture", targetCapability: "group-capability", rootAvailable: false, rootMessageId: "selected-root" })[key], setSize() {}, close() {}, async callFunction(input) { hostCalls.push(structuredClone(input)); return { result: input.name === "commands.ai.bindThread" ? { targetCapability: "thread-capability", rootAvailable: true, rootSource: "wam-selection" } : { status: "done", message: "fixture help", settings } }; } }; } });
await until(() => hostOnly.window.document.getElementById("state").textContent === "완료"); assert.deepEqual(hostCalls.map(call => call.name), ["commands.ai.bindThread", "commands.ai.execute"]); assert.deepEqual(hostCalls[0].params, { targetCapability: "group-capability", rootMessageId: "selected-root" }); assert.equal(hostCalls[1].params.targetCapability, "thread-capability"); assert.equal(hostOnly.window.document.getElementById("question").disabled, false); assert.match(hostOnly.window.document.getElementById("context").textContent, /채널톡 화면에서 선택한 원글/); hostOnly.window.close();
const unavailable = new JSDOM(aiPanel(), { runScripts: "dangerously" }); assert.match(unavailable.window.document.getElementById("context").textContent, /채널톡에서 \/ai/); assert.equal(unavailable.window.document.getElementById("question").disabled, true); unavailable.window.close();
process.stdout.write("WAM UI checks passed: initialization, root badges, read-only missing root, safe text, retained draft, stable retry, explicit shared context.\n");
