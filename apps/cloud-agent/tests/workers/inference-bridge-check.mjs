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
import {CloudAgentInference,terminalDiagnostic} from ${JSON.stringify(source)};
import {createModels} from '@earendil-works/pi-ai/models';
import {installSubscriptionModels} from ${JSON.stringify(join(app, "workers/pi/subscription-models.js"))};
export {CloudAgentInference};
const originalWarn=console.warn.bind(console);
console.warn=(...args)=>{if(args[0]==='inference_bridge_diagnostic'){globalThis.fixtureDiagnostics??=[];globalThis.fixtureDiagnostics.push(args);if(globalThis.fixtureObserverThrows)throw Error('PRIVATE observer failure');return;}originalWarn(...args);};
const originalFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(...args)=>{globalThis.fixtureFetchAttempts=(globalThis.fixtureFetchAttempts??0)+1;globalThis.fixtureFetchHeaders=Object.fromEntries(new Headers(args[1]?.headers));if(globalThis.fixtureCredentialMode==='fetch_failure'||globalThis.fixtureCredentialMode==='retry_fetch_failure'&&globalThis.fixtureFetchAttempts>1)throw Error('PRIVATE fetch failure');if(globalThis.fixtureCredentialMode==='fetch_html_failure')throw Error('<html><body>PRIVATE fetch failure</body></html>');const response=await originalFetch(...args);for(const field of ['redirected','url'])if(Object.hasOwn(globalThis.fixtureResponseMetadata??{},field))Object.defineProperty(response,field,{value:globalThis.fixtureResponseMetadata[field]});return response;};
export class Probe extends WorkerEntrypoint {
 signalCount(){return globalThis.fixtureProviderAborts??0;}
 diagnostics(){return globalThis.fixtureDiagnostics??[];}
 payload(){return globalThis.fixturePayload;}
 requestHeaders(){return globalThis.fixtureFetchHeaders;}
 credentialCalls(){return globalThis.fixtureCredentialCalls??0;}
 async native(context){const models=createModels();installSubscriptionModels(models,async()=>({async codexAccess(){return {access:${JSON.stringify(access)}};}}));const events=models.streamSimple(models.getModel('openai-codex',${JSON.stringify(model)}),context,{reasoning:'low',signal:AbortSignal.timeout(3000)});for await(const event of events){}return events.result();}
 projectDiagnostic(value){return terminalDiagnostic(value);}
 fetchAttempts(){return globalThis.fixtureFetchAttempts??0;}
 configure({mode='normal',observerThrows=false,responseMetadata={},retryLimit}={}){globalThis.fixtureCredentialMode=mode;globalThis.fixtureObserverThrows=observerThrows;globalThis.fixtureResponseMetadata=responseMetadata;globalThis.fixtureRetryLimit=retryLimit;globalThis.fixtureFetchAttempts=0;globalThis.fixtureDiagnostics=[];}
}
export default {fetch(){return new Response(null,{status:404});}};
export class Faults extends WorkerEntrypoint {
 infer(input){const prompt=input.context.messages[0].content;return new ReadableStream({type:'bytes',start(c){c.enqueue(prompt==='invalid_utf8'?new Uint8Array([255]):new TextEncoder().encode(prompt==='oversized'?'x'.repeat(600000):'{"version":2}\\n'));c.close();}});}
}
export class Credentials extends DurableObject {
 async status(){globalThis.fixtureCredentialCalls=(globalThis.fixtureCredentialCalls??0)+1;return {provider:'codex',inferenceReady:true};}
 async codexAccess(){if(globalThis.fixtureCredentialMode==='held_credential_failure'){await new Promise(resolve=>setTimeout(resolve,3500));throw Error('PRIVATE held credential failure');}if(globalThis.fixtureCredentialMode==='credential_failure')throw Error('PRIVATE credential failure');return {access:globalThis.fixtureCredentialMode==='setup_failure'?'PRIVATE invalid credential':${JSON.stringify(access)}};}
}`);
await writeFile(join(work, "client.ts"), `import {cloudAgentModel} from ${JSON.stringify(adapter)};
export default {async fetch(request,env){
 try{
  const input=await request.json();
  if(input.signalCount)return Response.json({count:await env.PROBE.signalCount()});
  if(input.diagnostics)return Response.json(await env.PROBE.diagnostics());
  if(input.payload)return Response.json(await env.PROBE.payload());
  if(input.requestHeaders)return Response.json(await env.PROBE.requestHeaders());
  if(input.credentialCalls)return Response.json({count:await env.PROBE.credentialCalls()});
  if(input.nativeProvider)return Response.json(await env.PROBE.native(input.context));
  if(input.projectDiagnostic)return Response.json(await env.PROBE.projectDiagnostic(input.projectDiagnostic));
  if(input.fetchAttempts)return Response.json({count:await env.PROBE.fetchAttempts()});
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
      contents: (await readFile(args.path, "utf8")).replace("function terminalDiagnostic(", "export function terminalDiagnostic(").replace("...input.options, maxTokens:", "...input.options, maxRetries: globalThis.fixtureRetryLimit, maxTokens:").replace("onPayload: body => {", "onPayload: body => { globalThis.fixturePayload=JSON.stringify(body);").replace("const iterator = models.streamSimple", "abort.signal.addEventListener('abort',()=>globalThis.fixtureProviderAborts=(globalThis.fixtureProviderAborts??0)+1,{once:true}); const iterator = models.streamSimple"), loader: "js"
    }));
  } }]
});
await bundle("server.js", join(root, "node_modules/@earendil-works/pi-ai"));
await bundle("client.ts", upstream ? join(upstream, "packages/workshop-backend/node_modules/@earendil-works/pi-ai") : join(root, "node_modules/@earendil-works/pi-ai"));
let calls = 0, seenToolOutput = false, lastNative, lastWire;
const sse = (events) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const outbound = async request => {
  calls++;
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers.get("authorization"), "Bearer " + access);
  const bytes = Buffer.from(await request.arrayBuffer());
  lastWire = { encoding: request.headers.get("content-encoding") ?? "identity", byteLength: bytes.byteLength, headers: Object.fromEntries(request.headers), json: request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString() };
  const body = JSON.parse(lastWire.json);
  lastNative = body;
  assert.equal(body.model, model);
  seenToolOutput ||= body.input.some(item => item.type === "function_call_output" && item.output.includes("READ_ONLY_OK"));
  if (JSON.stringify(body).includes("provider_denial")) return new Response("secret raw provider failure", { status: 403, headers: { "content-type": "application/json", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id" } });
  if (JSON.stringify(body).includes("provider_challenge")) return new Response("<!doctype html><html><title>Just a moment...</title><body>PRIVATE provider html fixture@example.invalid</body></html>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id", "set-cookie": "PRIVATE-cookie" } });
  if (JSON.stringify(body).includes("provider_cf_details")) return new Response('<!doctype html><html><title>Attention Required! | Cloudflare</title><body><div id="cf-error-details"><span class="cf-error-code">1020</span><span class="cf-error-code">1009</span><span class="cf-error-code">1015</span>Sorry, you have been blocked</div>PRIVATE https://PRIVATE.invalid/PRIVATE fixture@example.invalid</body></html>' + "x".repeat(66000), { status: 403, headers: { "content-type": "text/html", "cf-error-type": "1020", "cf-error-origin": "PRIVATE-origin", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id" } });
  if (JSON.stringify(body).includes("provider_unknown_html")) return new Response('<html><title>PRIVATE unknown template</title><body><div id="PRIVATE-marker">PRIVATE body</div><!-- <title>Attention Required! | Cloudflare</title> --><script>"cf-error-details";"Sorry, you have been blocked"</script></body></html>', { status: 502, headers: { "content-type": "text/html", "cf-error-type": "PRIVATE-unknown-code", "cf-error-origin": "PRIVATE-origin" } });
  if (JSON.stringify(body).includes("retry_fetch_failure")) return new Response("PRIVATE retryable service unavailable", { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "0", "cf-error-type": "521", "cf-error-origin": "PRIVATE-origin" } });
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
const htmlKeys = ["htmlAttentionRequired", "htmlJustAMoment", "htmlErrorDetails", "htmlErrorCode", "htmlCode1020", "htmlCode1009", "htmlCode1015", "htmlBlockedPhrase"];
const diagnosticKeys = ["phase", "credentialAccessFailed", "fetchAttempted", "responseReceived", "status", "category", "contentType", "challenge", "requestEndpointExpected", "requestAuthorizationPresent", "requestAccountPresent", "requestContentTypePresent", "requestAcceptPresent", "payloadStoreFalse", "payloadStreamTrue", "payloadInputArray", "payloadToolSchemaValid", "responseRedirected", "responseFinalEndpointExpected", "requestWireEncoding", "requestWireKind", "requestWireByteLength", "cfErrorType", "cfErrorOriginPresent", ...htmlKeys, "htmlTruncated"].sort();
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
  for (const privateValue of [user, access, "fixture-account", "PRIVATE", "https://", "secret raw provider failure", "provider_denial", "provider_challenge", "fetch_failure", "sse_failure", "system-private", "tool-private", "hello", "requestId", "rayId", "errorMessage", "htmlMarkers"])
    assert(!serialized.includes(privateValue), `diagnostic excludes ${privateValue}`);
  return record;
};
try {
  let nativeReference;
  const context = { messages: [{ role: "system", content: "Fixture Unicode 한글🙂 instructions", timestamp: 0 }, { role: "user", content: "hello 한글🙂", timestamp: 1 }], tools: [{ name: "encoding_contract", description: "Fixture 한글🙂 tool", parameters: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false } }] };
  for (const encoding of [undefined, "native", "identity"]) {
  if (encoding !== undefined) await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_REQUEST_ENCODING: encoding } }] }));
  const plain = await invoke({ context });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.equal(plain.data.result.content[0]?.text, "BRIDGE_OK", JSON.stringify(plain.data));
  assert.equal(plain.data.result.usage.totalTokens, 7);
  assert.equal(plain.data.result.usage.cost.total, 0);
  assert(plain.data.events.some(event => event.type === "text_delta"));
  assert(!JSON.stringify(plain.data).includes(access));
  assert.equal(lastWire.json, (await invoke({ payload: true })).data, "fetch body is exactly the JSON captured before provider compression");
  const requestHeaders = (await invoke({ requestHeaders: true })).data;
  assert.equal(Number(lastWire.headers["content-length"]), lastWire.byteLength, "runtime framing describes the selected wire body");
  if (encoding === undefined) {
    assert.equal(lastWire.encoding, "zstd", "default retains the real installed provider's native compression");
    nativeReference = { ...structuredClone(lastWire), requestHeaders };
  } else {
    assert.equal(lastWire.encoding, encoding === "identity" ? "identity" : "zstd", "server-owned encoding selection changes only the bridge request");
    assert.equal(lastWire.json, nativeReference.json, "identity JSON equals the default zstd request after decompression, including Unicode and tools");
    const withoutEncoding = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "content-encoding"));
    assert.deepEqual(withoutEncoding(requestHeaders), withoutEncoding(nativeReference.requestHeaders), "every provider-supplied header except content-encoding is preserved");
  }
  const nativeProvider = await invoke({ nativeProvider: true, context });
  assert.equal(nativeProvider.data.content[0]?.text, "BRIDGE_OK");
  assert.equal(lastWire.encoding, "zstd", "ordinary subscription provider keeps native compression under the same Worker environment");
  assert.equal(lastWire.json, nativeReference.json, "ordinary provider context is unchanged");
  if (encoding === "native") continue;
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
  const beforeProviderDenial = calls;
  const denied = await invoke({ prompt: "provider_denial" });
  assert.equal(denied.data.result.stopReason, "error");
  assert.equal(denied.data.result.errorMessage, "inference_bridge_provider_error");
  assert(!JSON.stringify(denied.data).includes("secret raw provider failure"));
  assert.equal(calls, beforeProviderDenial + 1, "403 is not retried under either encoding");
  await checkDiagnostic({ phase: "response", credentialAccessFailed: false, fetchAttempted: true, responseReceived: true, status: 403, category: "permission_denied", contentType: "json", challenge: false, requestEndpointExpected: true, requestAuthorizationPresent: true, requestAccountPresent: true, requestContentTypePresent: true, requestAcceptPresent: true, payloadStoreFalse: true, payloadStreamTrue: true, payloadInputArray: true, payloadToolSchemaValid: true, requestWireEncoding: lastWire.encoding, requestWireKind: lastWire.encoding === "zstd" ? "bytes" : "string", requestWireByteLength: lastWire.byteLength, responseRedirected: false, responseFinalEndpointExpected: true, cfErrorType: null, cfErrorOriginPresent: false, ...Object.fromEntries(htmlKeys.map(key => [key, null])), htmlTruncated: null });
  for (const cancelBeforeHTTP of [false, true]) {
    await invoke({ configure: { mode: "held_credential_failure" } });
    const before = calls;
    const failure = await invoke({ direct: wire({}), cancelBeforeHTTP });
    assert.equal(failure.data.event.error.errorMessage, "inference_bridge_provider_error", "retain existing auth-setup race wire code");
    assert.equal(calls, before, "cancelled or timed-out credential setup makes no inference HTTP call");
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "credential failure after deadline or explicit cancellation emits no provider diagnostic");
  }
  for (const [prompt, expected] of [
    ["provider_challenge", { phase: "response", status: 403, category: "upstream_blocked", contentType: "html", challenge: true, cfErrorType: null, cfErrorOriginPresent: false, ...Object.fromEntries(htmlKeys.map(key => [key, key === "htmlJustAMoment"])), htmlTruncated: false }],
    ["provider_cf_details", { phase: "response", status: 403, contentType: "html", cfErrorType: "1020", cfErrorOriginPresent: true, ...Object.fromEntries(htmlKeys.map(key => [key, key !== "htmlJustAMoment"])), htmlTruncated: true }],
    ["provider_unknown_html", { phase: "response", status: 502, cfErrorType: "other", cfErrorOriginPresent: true, ...Object.fromEntries(htmlKeys.map(key => [key, false])), htmlTruncated: false }],
    ["fetch_failure", { phase: "fetch", fetchAttempted: true, responseReceived: false, status: null, category: null, contentType: null, challenge: null, requestAuthorizationPresent: true, payloadStoreFalse: true, responseRedirected: null, responseFinalEndpointExpected: null, cfErrorType: null, cfErrorOriginPresent: null, htmlAttentionRequired: null, htmlTruncated: null }],
    ["fetch_html_failure", { phase: "fetch", fetchAttempted: true, responseReceived: false, status: null, category: null, contentType: null, challenge: null, responseRedirected: null, responseFinalEndpointExpected: null, cfErrorType: null, cfErrorOriginPresent: null, htmlTruncated: null }],
    ["sse_failure", { phase: "response", fetchAttempted: true, responseReceived: true, status: 200, category: "success", contentType: "sse", challenge: false }]
  ]) {
    await invoke({ configure: { mode: prompt.startsWith("fetch_") ? prompt : "normal" } });
    const failure = await invoke({ context: { systemPrompt: "system-private", messages: [{ role: "user", content: prompt, timestamp: 1 }], tools: [{ ...tool, description: "tool-private" }] } });
    assert.equal(failure.data.result.stopReason, "error", prompt);
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error", prompt);
    await checkDiagnostic(expected);
  }
  for (const [responseMetadata, expected] of [
    [{ redirected: true, url: "https://PRIVATE.invalid/PRIVATE?token=PRIVATE" }, { responseRedirected: true, responseFinalEndpointExpected: false }],
    [{ redirected: false, url: "https://chatgpt.com/backend-api/codex/responses" }, { responseRedirected: false, responseFinalEndpointExpected: true }],
    [{ redirected: "PRIVATE-invalid-boolean", url: "PRIVATE-invalid-url" }, { responseRedirected: null, responseFinalEndpointExpected: null }]
  ]) {
    await invoke({ configure: { responseMetadata } });
    const failure = await invoke({ prompt: "provider_denial" });
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error");
    await checkDiagnostic(expected);
  }
  await invoke({ configure: { mode: "retry_fetch_failure", retryLimit: 1, responseMetadata: { redirected: true, url: "https://PRIVATE.invalid/PRIVATE" } } });
  const retriedFailure = await invoke({ prompt: "retry_fetch_failure" });
  assert.equal(retriedFailure.data.result.errorMessage, "inference_bridge_provider_error");
  assert.equal((await invoke({ fetchAttempts: true })).data.count, 2, "real provider retry reaches a second fetch attempt");
  await checkDiagnostic({ phase: "fetch", credentialAccessFailed: false, fetchAttempted: true, responseReceived: false, status: null, category: null, contentType: null, challenge: null, responseRedirected: null, responseFinalEndpointExpected: null, cfErrorType: null, cfErrorOriginPresent: null, ...Object.fromEntries(htmlKeys.map(key => [key, null])), htmlTruncated: null, requestEndpointExpected: true, requestAuthorizationPresent: true, requestWireEncoding: lastWire.encoding, requestWireKind: lastWire.encoding === "zstd" ? "bytes" : "string", requestWireByteLength: lastWire.byteLength });
  const unobserved = Object.fromEntries(diagnosticKeys.filter(key => !["phase", "credentialAccessFailed", "fetchAttempted", "responseReceived"].includes(key)).map(key => [key, null]));
  const baseObservation = { credentialAccessFailed: false, fetchAttempted: true, responseReceived: true };
  const projected = (await invoke({ projectDiagnostic: { ...baseObservation, request: { wire: { encoding: "PRIVATE-encoding", kind: "PRIVATE-kind", byteLength: 16777217 }, attemptId: "PRIVATE-id" }, response: { category: "PRIVATE-category", contentType: "PRIVATE-type", status: 999, redirected: "PRIVATE-boolean", expectedFinalEndpoint: "PRIVATE-url", cfErrorType: "PRIVATE-code", cfErrorOriginPresent: "PRIVATE-origin", htmlTruncated: "PRIVATE-boolean", ...Object.fromEntries(htmlKeys.map(key => [key, "PRIVATE-marker"])) } } })).data;
  assert.deepEqual(projected, { phase: "response", ...baseObservation, ...unobserved }, "untrusted diagnostic values collapse to fixed null fields");
  for (const [byteLength, expected] of [[0, 0], [16777216, 16777216], [-1, null], [1.5, null], ["PRIVATE-bytes", null], [null, null]]) {
    const record = (await invoke({ projectDiagnostic: { ...baseObservation, request: { wire: { encoding: "identity", kind: "string", byteLength } } } })).data;
    assert.equal(record.requestWireByteLength, expected, "wire byte length has a fixed diagnostic bound");
    assert.equal(record.requestWireEncoding, "identity");
    assert.equal(record.requestWireKind, "string");
  }
  for (const [mode, phase, credentialAccessFailed] of [["credential_failure", "credential", true], ["setup_failure", "provider_setup", false]]) {
    await invoke({ configure: { mode } });
    const before = calls;
    const failure = await invoke({});
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error", mode);
    assert.equal(calls, before, "pre-HTTP failure must not attempt HTTP");
    await checkDiagnostic({ phase, credentialAccessFailed, fetchAttempted: false, responseReceived: false, status: null, category: null, contentType: null, challenge: null, requestAuthorizationPresent: null, payloadStoreFalse: null, requestWireEncoding: null, requestWireKind: null, requestWireByteLength: null, responseRedirected: null, responseFinalEndpointExpected: null, cfErrorType: null, cfErrorOriginPresent: null, htmlAttentionRequired: null, htmlTruncated: null });
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
  console.log(`inference bridge native check passed (${upstream ? "pinned OS cross-version" : "installed Pi"}, ${encoding ?? "default native"}): text/tool roundtrip, private binding, allowlist, model/credential rejection, output sanitization, malformed/oversized frames, cancel/deadline, token accounting; 14 failure diagnostic scenarios, redirect/wire/Cloudflare/HTML classifications, latest retry attempt, fixed-schema redaction and unknowns, observer isolation and no success/cancellation diagnostics`);
  }
  await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_REQUEST_ENCODING: "gzip" } }] }));
  const beforeInvalidEncoding = calls;
  const beforeInvalidCredentials = (await invoke({ credentialCalls: true })).data.count;
  const invalidEncoding = await invoke({ direct: wire({}) });
  assert.equal(invalidEncoding.status, 400);
  assert.equal(invalidEncoding.data.error, "inference_bridge_not_configured", "unknown encoding is rejected rather than silently activating transport changes");
  assert.equal(calls, beforeInvalidEncoding, "invalid encoding never reaches provider HTTP");
  assert.equal((await invoke({ credentialCalls: true })).data.count, beforeInvalidCredentials, "invalid encoding is rejected before credential lookup");
  console.log("inference bridge encoding contract passed: default/explicit native, exact identity JSON/header preservation, both complete behavior suites, no retry and invalid-setting refusal");
} finally { await mf.dispose(); await rm(work, { recursive: true, force: true }); }
