import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(app, "../..");
const upstream = process.env.CLOUDFLARE_OS_SOURCE;
const work = await mkdtemp(join(tmpdir(), "inference-bridge-"));
const user = "fixture@example.invalid", model = "gpt-6.1-sol";
const access = "e30." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url") + ".fixture-signature";
const source = join(app, "workers/pi/inference-entrypoint.js");
const adapter = join(root, "apps/cloud-agent-os/overlay/packages/workshop-backend/src/cloud-agent-model.ts");
await writeFile(join(work, "server.js"), `import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
export {CloudAgentInference} from ${JSON.stringify(source)};
const originalWarn=console.warn.bind(console);
console.warn=(...args)=>{if(args[0]==='inference_bridge_diagnostic'){globalThis.fixtureDiagnostics??=[];globalThis.fixtureDiagnostics.push(args);if(globalThis.fixtureObserverThrows)throw Error('PRIVATE observer failure');return;}originalWarn(...args);};
const originalFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(...args)=>{if(globalThis.fixtureCredentialMode==='fetch_failure')throw Error('PRIVATE fetch failure');if(globalThis.fixtureCredentialMode==='fetch_html_failure')throw Error('<html><body>PRIVATE fetch failure</body></html>');return originalFetch(...args);};
export class Probe extends WorkerEntrypoint {
 signalCount(){return globalThis.fixtureProviderAborts??0;}
 diagnostics(){return globalThis.fixtureDiagnostics??[];}
 configure({mode='normal',observerThrows=false}={}){globalThis.fixtureCredentialMode=mode;globalThis.fixtureObserverThrows=observerThrows;globalThis.fixtureDiagnostics=[];}
}
export default {fetch(){return new Response(null,{status:404});}};
export class Faults extends WorkerEntrypoint {
 infer(input){const prompt=input.context.messages[0].content;return new ReadableStream({type:'bytes',start(c){c.enqueue(prompt==='invalid_utf8'?new Uint8Array([255]):new TextEncoder().encode(prompt==='oversized'?'x'.repeat(600000):'{"version":2}\\n'));c.close();}});}
}
export class Credentials extends DurableObject {
 async status(){return {provider:'codex',inferenceReady:true};}
 async codexAccess(){if(globalThis.fixtureCredentialMode==='held_credential_failure'){await new Promise(resolve=>setTimeout(resolve,3500));throw Error('PRIVATE held credential failure');}if(globalThis.fixtureCredentialMode==='credential_failure')throw Error('PRIVATE credential failure');return {access:globalThis.fixtureCredentialMode==='setup_failure'?'PRIVATE invalid credential':${JSON.stringify(access)}};}
}`);
await writeFile(join(work, "client.ts"), `import {cloudAgentModel} from ${JSON.stringify(adapter)};
export default {async fetch(request,env){
 try{
  const input=await request.json();
  if(input.signalCount)return Response.json({count:await env.PROBE.signalCount()});
  if(input.diagnostics)return Response.json(await env.PROBE.diagnostics());
  if(input.configure){await env.PROBE.configure(input.configure);return Response.json({ok:true});}
  const context=input.context??{messages:[{role:'user',content:input.prompt??'hello',timestamp:1}],tools:input.tools};
  if(input.direct){const call=await env.CODEX_BRIDGE.infer(input.direct);if(input.cancelBeforeHTTP)await call.cancellation.cancel();return new Response(call.stream);}
  const transport=input.fault?{...env,CODEX_BRIDGE:{async infer(input){return {stream:await env.FAULT_BRIDGE.infer(input),cancellation:{async cancel(){},[Symbol.dispose](){}}};}}}:env;
  const handle=cloudAgentModel(transport,{provider:'openai',model:${JSON.stringify(model)},apiToken:'',...input.config},{type:'user',id:${JSON.stringify(user)},name:'Fixture',...input.actor});
  const abort=new AbortController();
  const events=handle.stream(handle.model,context,{signal:abort.signal,maxTokens:128});
  const collected=[];for await(const event of events){collected.push(event);if(input.abort&&event.type==='text_delta')abort.abort();}
  return Response.json({events:collected,result:await events.result()});
 }catch(error){return Response.json({error:error.message},{status:400});}
}};`);
const bundle = async (file, piDirectory) => build({
  entryPoints: [join(work, file)], outfile: join(work, file + ".bundle.js"), bundle: true,
  format: "esm", platform: "node", target: "es2022", external: ["cloudflare:*", "node:*"], logLevel: "silent",
  plugins: [{ name: "pinned-pi", setup(builder) {
    builder.onResolve({ filter: /^@earendil-works\/pi-ai(?:\/|$)/ }, args => ({
      path: join(piDirectory, "dist", (args.path.slice("@earendil-works/pi-ai/".length) || "index") + ".js")
    }));
    builder.onLoad({ filter: /inference-entrypoint\.js$/ }, async args => ({
      contents: (await readFile(args.path, "utf8")).replace("const iterator = models.streamSimple", "abort.signal.addEventListener('abort',()=>globalThis.fixtureProviderAborts=(globalThis.fixtureProviderAborts??0)+1,{once:true}); const iterator = models.streamSimple"), loader: "js"
    }));
  } }]
});
await bundle("server.js", join(root, "node_modules/@earendil-works/pi-ai"));
await bundle("client.ts", upstream ? join(upstream, "packages/workshop-backend/node_modules/@earendil-works/pi-ai") : join(root, "node_modules/@earendil-works/pi-ai"));
let calls = 0, seenToolOutput = false, lastNative;
const sse = (events) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const outbound = async request => {
  calls++;
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers.get("authorization"), "Bearer " + access);
  const bytes = Buffer.from(await request.arrayBuffer());
  const body = JSON.parse(request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString());
  lastNative = body;
  assert.equal(body.model, model);
  seenToolOutput ||= body.input.some(item => item.type === "function_call_output" && item.output.includes("READ_ONLY_OK"));
  if (JSON.stringify(body).includes("provider_denial")) return new Response("secret raw provider failure", { status: 403, headers: { "content-type": "application/json", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id" } });
  if (JSON.stringify(body).includes("provider_challenge")) return new Response("<!doctype html><html><title>Just a moment...</title><body>PRIVATE provider html fixture@example.invalid</body></html>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id", "set-cookie": "PRIVATE-cookie" } });
  if (JSON.stringify(body).includes("sse_failure")) return sse([{ type: "response.failed", response: { error: { code: "PRIVATE-error-code", message: "PRIVATE SSE failure" } } }]);
  if (JSON.stringify(body).includes("hold_stream")) {
    const events = [
      { type: "response.created", response: { id: "resp_hold", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_hold", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "msg_hold", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_hold", output_index: 0, content_index: 0, delta: "FIRST" }
    ];
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))); } }), { headers: { "content-type": "text/event-stream" } });
  }
  const tool = JSON.stringify(body).includes("use_read_tool") && !body.input.some(item => item.type === "function_call_output");
  const item = tool ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read_health", arguments: "{}", status: "completed" }
    : { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "BRIDGE_OK", annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : { content: [] }) } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" }]
      : [{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "BRIDGE_OK" }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  ]);
};
const common = { modulesRoot: work, compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"] };
const server = { ...common, name: "bridge-server", modules: true, scriptPath: join(work, "server.js.bundle.js"), durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, bindings: { INFERENCE_BRIDGE_MODEL: model, INFERENCE_BRIDGE_ACCOUNT_ID: "owner", INFERENCE_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([user]), INFERENCE_BRIDGE_TIMEOUT_MS: "3000" }, outboundService: outbound };
const client = { ...common, name: "bridge-client", modules: true, scriptPath: join(work, "client.ts.bundle.js"), serviceBindings: { CODEX_BRIDGE: { name: "bridge-server", entrypoint: "CloudAgentInference" }, FAULT_BRIDGE: { name: "bridge-server", entrypoint: "Faults" }, PROBE: { name: "bridge-server", entrypoint: "Probe" } }, bindings: { CODEX_BRIDGE_MODEL: model, CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([user]) } };
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [client, server] }));
const invoke = async input => { const response = await mf.dispatchFetch("https://fixture.invalid", { method: "POST", body: JSON.stringify(input) }); return { status: response.status, data: await response.json() }; };
const wire = changes => ({ version: 1, requestId: crypto.randomUUID(), userId: user, context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, options: {}, ...changes });
const diagnosticKeys = ["phase", "credentialAccessFailed", "fetchAttempted", "responseReceived", "status", "category", "contentType", "challenge", "requestEndpointExpected", "requestAuthorizationPresent", "requestAccountPresent", "requestContentTypePresent", "requestAcceptPresent", "payloadStoreFalse", "payloadStreamTrue", "payloadInputArray", "payloadToolSchemaValid"].sort();
const checkDiagnostic = async expected => {
  const logs = (await invoke({ diagnostics: true })).data;
  assert.equal(logs.length, 1, "one terminal diagnostic per provider failure");
  assert.equal(logs[0].length, 2);
  assert.equal(logs[0][0], "inference_bridge_diagnostic");
  const record = JSON.parse(logs[0][1]);
  assert.deepEqual(Object.keys(record).sort(), diagnosticKeys);
  assert(Object.values(record).every(value => value === null || ["string", "boolean", "number"].includes(typeof value)), "fixed-schema primitive values only");
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, key);
  const serialized = JSON.stringify(logs);
  for (const privateValue of [user, access, "fixture-account", "PRIVATE", "secret raw provider failure", "provider_denial", "provider_challenge", "fetch_failure", "sse_failure", "system-private", "tool-private", "hello", "requestId", "rayId", "errorMessage"])
    assert(!serialized.includes(privateValue), `diagnostic excludes ${privateValue}`);
  return record;
};
try {
  const plain = await invoke({});
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.equal(plain.data.result.content[0]?.text, "BRIDGE_OK", JSON.stringify(plain.data));
  assert.equal(plain.data.result.usage.totalTokens, 7);
  assert.equal(plain.data.result.usage.cost.total, 0);
  assert(plain.data.events.some(event => event.type === "text_delta"));
  assert(!JSON.stringify(plain.data).includes(access));
  const tool = { name: "read_health", description: "Read only", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const first = await invoke({ prompt: "use_read_tool", tools: [tool] });
  assert.equal(first.data.result.stopReason, "toolUse", JSON.stringify(first.data));
  const called = first.data.result.content.find(block => block.type === "toolCall");
  assert.equal(called.name, "read_health");
  const next = await invoke({ context: { messages: [{ role: "system", content: "Use declared tools", toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "use_read_tool", timestamp: 1 }, first.data.result, { role: "toolResult", toolCallId: called.id, toolName: called.name, content: [{ type: "text", text: "READ_ONLY_OK" }], isError: false, timestamp: 3 }] } });
  assert.equal(next.data.result.content[0].text, "BRIDGE_OK", JSON.stringify(next.data));
  assert(seenToolOutput);
  assert(lastNative.tools.some(tool => tool.name === "read_health"));
  assert.deepEqual((await invoke({ diagnostics: true })).data, [], "successful calls emit no diagnostic");
  const beforeDenied = calls;
  for (const input of [{ actor: { id: "other@example.invalid" } }, { actor: { type: "gadget" } }, { config: { model: "other-model" } }, { config: { apiToken: "forbidden" } }, { config: { apiUrl: "https://other.invalid" } }, { direct: wire({ accountId: "other" }) }, { direct: wire({ userId: "other@example.invalid" }) }, { direct: wire({ options: { headers: { authorization: "forbidden" } } }) }, { direct: wire({ context: { messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }] } }) }, { direct: wire({ context: { messages: [{ role: "user", content: "x".repeat(1100000), timestamp: 1 }] } }) }]) {
    const denied = await invoke(input); assert.equal(denied.status, 400, JSON.stringify(denied));
  }
  assert.equal(calls, beforeDenied);
  assert.deepEqual((await invoke({ diagnostics: true })).data, [], "input rejection emits no provider diagnostic");
  const denied = await invoke({ prompt: "provider_denial" });
  assert.equal(denied.data.result.stopReason, "error");
  assert.equal(denied.data.result.errorMessage, "inference_bridge_provider_error");
  assert(!JSON.stringify(denied.data).includes("secret raw provider failure"));
  await checkDiagnostic({ phase: "response", credentialAccessFailed: false, fetchAttempted: true, responseReceived: true, status: 403, category: "permission_denied", contentType: "json", challenge: false, requestEndpointExpected: true, requestAuthorizationPresent: true, requestAccountPresent: true, requestContentTypePresent: true, requestAcceptPresent: true, payloadStoreFalse: true, payloadStreamTrue: true, payloadInputArray: true, payloadToolSchemaValid: true });
  for (const cancelBeforeHTTP of [false, true]) {
    await invoke({ configure: { mode: "held_credential_failure" } });
    const before = calls;
    const failure = await invoke({ direct: wire({}), cancelBeforeHTTP });
    assert.equal(failure.data.event.error.errorMessage, "inference_bridge_provider_error", "retain existing auth-setup race wire code");
    assert.equal(calls, before, "cancelled or timed-out credential setup makes no inference HTTP call");
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "credential failure after deadline or explicit cancellation emits no provider diagnostic");
  }
  for (const [prompt, expected] of [
    ["provider_challenge", { phase: "response", status: 403, category: "upstream_blocked", contentType: "html", challenge: true }],
    ["fetch_failure", { phase: "fetch", fetchAttempted: true, responseReceived: false, status: null, category: null, contentType: null, challenge: null, requestAuthorizationPresent: true, payloadStoreFalse: true }],
    ["fetch_html_failure", { phase: "fetch", fetchAttempted: true, responseReceived: false, status: null, category: null, contentType: null, challenge: null }],
    ["sse_failure", { phase: "response", fetchAttempted: true, responseReceived: true, status: 200, category: "success", contentType: "sse", challenge: false }]
  ]) {
    await invoke({ configure: { mode: prompt.startsWith("fetch_") ? prompt : "normal" } });
    const failure = await invoke({ context: { systemPrompt: "system-private", messages: [{ role: "user", content: prompt, timestamp: 1 }], tools: [{ ...tool, description: "tool-private" }] } });
    assert.equal(failure.data.result.stopReason, "error", prompt);
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error", prompt);
    await checkDiagnostic(expected);
  }
  for (const [mode, phase, credentialAccessFailed] of [["credential_failure", "credential", true], ["setup_failure", "provider_setup", false]]) {
    await invoke({ configure: { mode } });
    const before = calls;
    const failure = await invoke({});
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error", mode);
    assert.equal(calls, before, "pre-HTTP failure must not attempt HTTP");
    await checkDiagnostic({ phase, credentialAccessFailed, fetchAttempted: false, responseReceived: false, status: null, category: null, contentType: null, challenge: null, requestAuthorizationPresent: null, payloadStoreFalse: null });
  }
  await invoke({ configure: { observerThrows: true } });
  const observerFailure = await invoke({ prompt: "provider_denial" });
  assert.equal(observerFailure.data.result.errorMessage, "inference_bridge_provider_error", "observer failure must preserve the wire error");
  await checkDiagnostic({ phase: "response", status: 403 });
  await invoke({ configure: {} });
  const beforeAbort = (await invoke({ signalCount: true })).data.count;
  const aborted = await invoke({ abort: true, prompt: "hold_stream" });
  assert.equal(aborted.data.result.stopReason, "aborted");
  let afterCancel = (await invoke({ signalCount: true })).data.count;
  for (let attempt = 0; afterCancel === beforeAbort && attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    afterCancel = (await invoke({ signalCount: true })).data.count;
  }
  assert.equal(afterCancel, beforeAbort + 1, "RPC reader cancellation aborts the provider without waiting for the deadline");
  const timeout = await invoke({ prompt: "hold_stream" });
  assert.equal(timeout.data.result.stopReason, "aborted");
  for (const prompt of ["invalid_utf8", "oversized", "invalid_version"]) {
    const fault = await invoke({ fault: true, prompt });
    assert.equal(fault.data.result.stopReason, "error");
  }
  const afterAbort = (await invoke({ signalCount: true })).data.count;
  assert(afterAbort >= beforeAbort + 2, "cancel and deadline reach the provider stream AbortSignal");
  assert.deepEqual((await invoke({ diagnostics: true })).data, [], "cancel, deadline and invalid bridge frames emit no provider diagnostic");
  assert.equal((await (await mf.getWorker("bridge-server")).fetch("https://public.invalid/infer")).status, 404);
  console.log(`inference bridge native check passed (${upstream ? "pinned OS cross-version" : "installed Pi"}): text/tool roundtrip, private binding, allowlist, model/credential rejection, output sanitization, malformed/oversized frames, cancel/deadline, token accounting; 8 failure diagnostic scenarios, fixed-schema redaction, observer isolation and no success/cancellation diagnostics`);
} finally { await mf.dispose(); await rm(work, { recursive: true, force: true }); }
