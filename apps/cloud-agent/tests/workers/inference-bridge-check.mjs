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
const siwcAccess = "fixture-siwc-bearer";
const source = join(app, "workers/pi/inference-entrypoint.js");
const adapter = join(root, "apps/cloud-agent-os/overlay/packages/workshop-backend/src/cloud-agent-model.ts");
await writeFile(join(work, "server.js"), `import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {CloudAgentInference,terminalDiagnostic,credentialExpiry} from ${JSON.stringify(source)};
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
 catalogCalls(){return globalThis.fixtureCatalogCalls??0;}
 accessCalls(){return {codex:globalThis.fixtureCodexAccessCalls??0,siwc:globalThis.fixtureSiwcAccessCalls??0};}
 async native(context,siwc=false){const models=createModels();installSubscriptionModels(models,async()=>({async codexAccess(){return {access:${JSON.stringify(access)}};},async access(){return ${JSON.stringify(siwcAccess)};}}));const events=models.streamSimple(models.getModel(siwc?'openai':'openai-codex',${JSON.stringify(model)}),context,{...(siwc?{maxTokens:4096}:{reasoning:'low'}),signal:AbortSignal.timeout(3000)});for await(const event of events){}return events.result();}
 projectDiagnostic(value){return terminalDiagnostic(value);}
 checkExpiry(value){return credentialExpiry(value,1000000);}
 fetchAttempts(){return globalThis.fixtureFetchAttempts??0;}
 configure({mode='normal',observerThrows=false,responseMetadata={},retryLimit,status={},catalog}={}){globalThis.fixtureCredentialMode=mode;globalThis.fixtureStatus=status;globalThis.fixtureCatalog=catalog;globalThis.fixtureCatalogCalls=0;globalThis.fixtureObserverThrows=observerThrows;globalThis.fixtureResponseMetadata=responseMetadata;globalThis.fixtureRetryLimit=retryLimit;globalThis.fixtureFetchAttempts=0;globalThis.fixtureDiagnostics=[];globalThis.fixtureCodexAccessCalls=0;globalThis.fixtureSiwcAccessCalls=0;}
}
export default {fetch(){return new Response(null,{status:404});}};
export class Faults extends WorkerEntrypoint {
 infer(input){const prompt=input.context.messages[0].content;return new ReadableStream({type:'bytes',start(c){c.enqueue(prompt==='invalid_utf8'?new Uint8Array([255]):new TextEncoder().encode(prompt==='oversized'?'x'.repeat(600000):'{"version":2}\\n'));c.close();}});}
}
export class Credentials extends DurableObject {
 async subscriptionModels(){globalThis.fixtureCatalogCalls=(globalThis.fixtureCatalogCalls??0)+1;return globalThis.fixtureCatalog;}
 async status(){globalThis.fixtureCredentialCalls=(globalThis.fixtureCredentialCalls??0)+1;return {provider:'codex',inferenceReady:true,codexInferenceReady:true,siwcInferenceReady:true,connected:true,directUsageGranted:true,...globalThis.fixtureStatus};}
 async codexAccess(){globalThis.fixtureCodexAccessCalls=(globalThis.fixtureCodexAccessCalls??0)+1;if(globalThis.fixtureCredentialMode==='held_credential_failure'){await new Promise(resolve=>setTimeout(resolve,3500));throw Error('PRIVATE held credential failure');}if(globalThis.fixtureCredentialMode==='credential_failure')throw Error('PRIVATE credential failure');return {access:globalThis.fixtureCredentialMode==='setup_failure'?'PRIVATE invalid credential':${JSON.stringify(access)}};}
 async access(){globalThis.fixtureSiwcAccessCalls=(globalThis.fixtureSiwcAccessCalls??0)+1;if(globalThis.fixtureCredentialMode==='credential_failure')throw Error('PRIVATE legacy credential failure');return ${JSON.stringify(siwcAccess)};}
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
  if(input.catalogCalls)return Response.json({count:await env.PROBE.catalogCalls()});
  if(input.subscriptionModels)return Response.json(await env.CODEX_BRIDGE.subscriptionModels());
  if(input.accessCalls)return Response.json(await env.PROBE.accessCalls());
  if(input.nativeProvider)return Response.json(await env.PROBE.native(input.context,input.siwc));
  if(input.projectDiagnostic)return Response.json(await env.PROBE.projectDiagnostic(input.projectDiagnostic));
  if(input.checkExpiry)return Response.json({expiry:await env.PROBE.checkExpiry(input.checkExpiry.token)});
  if(input.fetchAttempts)return Response.json({count:await env.PROBE.fetchAttempts()});
  if(input.configure){await env.PROBE.configure(input.configure);return Response.json({ok:true});}
  const context=input.context??{messages:[{role:'user',content:input.prompt??'hello',timestamp:1}],tools:input.tools};
  if(input.admission){const call=await env.CODEX_BRIDGE.infer(input.admission);await call.cancellation.cancel();await call.stream.cancel();return Response.json({admitted:true});}
  if(input.direct){const call=await env.CODEX_BRIDGE.infer(input.direct);if(input.cancelBeforeHTTP)await call.cancellation.cancel();return new Response(call.stream);}
  if(input.bridge){const call=await env.CODEX_BRIDGE.infer(input.bridge);try{const body=await new Response(call.stream).text();const events=body.trim().split('\\n').map(line=>JSON.parse(line).event);const terminal=events.at(-1);return Response.json({events,result:terminal.message??terminal.error});}finally{call.cancellation[Symbol.dispose]();}}
  const transport=input.fault?{...env,CODEX_BRIDGE:{async infer(input){return {stream:await env.FAULT_BRIDGE.infer(input),cancellation:{async cancel(){},[Symbol.dispose](){}}};}}}:env;
  const handle=cloudAgentModel(transport,{provider:'openai',model:${JSON.stringify(model)},apiToken:'',...input.config},{type:'user',id:${JSON.stringify(user)},name:'Fixture',...input.actor},{fastMode:input.fastMode});
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
      contents: (await readFile(args.path, "utf8")).replace("function terminalDiagnostic(", "export function terminalDiagnostic(").replace("function credentialExpiry(", "export function credentialExpiry(").replace("...input.options, maxTokens:", "...input.options, maxRetries: globalThis.fixtureRetryLimit, maxTokens:").replace("onPayload: body => {", "onPayload: body => { globalThis.fixturePayload=JSON.stringify(body);").replace("const iterator = models.streamSimple", "abort.signal.addEventListener('abort',()=>globalThis.fixtureProviderAborts=(globalThis.fixtureProviderAborts??0)+1,{once:true}); const iterator = models.streamSimple"), loader: "js"
    }));
  } }]
});
await bundle("server.js", join(root, "node_modules/@earendil-works/pi-ai"));
await bundle("client.ts", upstream ? join(upstream, "packages/workshop-backend/node_modules/@earendil-works/pi-ai") : join(root, "node_modules/@earendil-works/pi-ai"));
let calls = 0, seenToolOutput = false, lastNative, lastWire, expectedProvider = "codex", expectedModel = model;
let responseModelFixture, retryResponse = false;
const sse = (events) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const outbound = async request => {
  calls++;
  assert.equal(request.url, expectedProvider === "siwc" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers.get("authorization"), "Bearer " + (expectedProvider === "siwc" ? siwcAccess : access));
  const bytes = Buffer.from(await request.arrayBuffer());
  lastWire = { encoding: request.headers.get("content-encoding") ?? "identity", byteLength: bytes.byteLength, headers: Object.fromEntries(request.headers), json: request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString() };
  const body = JSON.parse(lastWire.json);
  lastNative = body;
  assert.equal(body.model, expectedModel);
  if (retryResponse) { retryResponse = false; return new Response('Fixture temporary failure', { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } }); }
  seenToolOutput ||= body.input.some(item => item.type === "function_call_output" && item.output.includes("READ_ONLY_OK"));
  if (JSON.stringify(body).includes("provider_denial")) return new Response("secret raw provider failure", { status: 403, headers: { "content-type": "application/json", "x-request-id": "PRIVATE-request-id", "cf-ray": "PRIVATE-ray-id-HKG", "server":"cloudflare" } });
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
  const outputChunks = JSON.stringify(body).includes("bridge_total_limit") ? Array(200).fill("x".repeat(1024))
    : [JSON.stringify(body).includes("bridge_frame_limit") ? "x".repeat(262144) : JSON.stringify(body).includes("OS_OK") ? "OS_OK" : "BRIDGE_OK"];
  const reply = outputChunks.join("");
  const tool = JSON.stringify(body).includes("use_read_tool") && !body.input.some(item => item.type === "function_call_output");
  const item = tool ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read_health", arguments: "{}", status: "completed" }
    : { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", ...responseModelFixture?.created } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : { content: [] }) } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" }]
      : [{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, ...outputChunks.map(delta => ({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta }))]),
    { type: "response.output_item.done", output_index: 0, item },
    ...(responseModelFixture?.extraEvents ?? []),
    ...(responseModelFixture?.terminals ?? [{ type: "response.completed", fields: {} }]).map(({ type, fields }) => ({ type, response: { id: "resp_fixture", status: type === "response.incomplete" ? "incomplete" : "completed", output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, ...fields } }))
  ]);
};
const common = { modulesRoot: work, compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"] };
const server = { ...common, name: "bridge-server", modules: true, scriptPath: join(work, "server.js.bundle.js"), durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, bindings: { INFERENCE_BRIDGE_MODEL: model, INFERENCE_BRIDGE_ACCOUNT_ID: "owner", INFERENCE_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([user]), INFERENCE_BRIDGE_TIMEOUT_MS: "3000" }, outboundService: outbound };
const client = { ...common, name: "bridge-client", modules: true, scriptPath: join(work, "client.ts.bundle.js"), serviceBindings: { CODEX_BRIDGE: { name: "bridge-server", entrypoint: "CloudAgentInference" }, FAULT_BRIDGE: { name: "bridge-server", entrypoint: "Faults" }, PROBE: { name: "bridge-server", entrypoint: "Probe" } }, bindings: { CODEX_BRIDGE_MODEL: model, CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([user]) } };
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [client, server] }));
const invoke = async input => { const response = await mf.dispatchFetch("https://fixture.invalid", { method: "POST", body: JSON.stringify(input) }); return { status: response.status, data: await response.json() }; };
const wire = changes => ({ version: 1, requestId: crypto.randomUUID(), userId: user, context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, options: {}, ...changes });
const htmlKeys = ["htmlAttentionRequired", "htmlJustAMoment", "htmlErrorDetails", "htmlErrorCode", "htmlCode1020", "htmlCode1009", "htmlCode1015", "htmlBlockedPhrase"];
const diagnosticKeys = ["provider", "phase", "credentialAccessFailed", "fetchAttempted", "responseReceived", "status", "category", "contentType", "challenge", "requestEndpointExpected", "requestAuthorizationPresent", "requestAccountPresent", "requestContentTypePresent", "requestAcceptPresent", "payloadStoreFalse", "payloadStreamTrue", "payloadInputArray", "payloadToolSchemaValid", "responseRedirected", "responseFinalEndpointExpected", "requestWireEncoding", "requestWireKind", "requestWireByteLength", "credentialExpiry", "responseEdgeColo", "responseServer", "cfErrorType", "cfErrorOriginPresent", ...htmlKeys, "htmlTruncated"].sort();
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
  for (const privateValue of [user, access, siwcAccess, "fixture-account", "PRIVATE", "https://", "secret raw provider failure", "provider_denial", "provider_challenge", "fetch_failure", "sse_failure", "system-private", "tool-private", "hello", "requestId", "rayId", "errorMessage", "htmlMarkers"])
    assert(!serialized.includes(privateValue), `diagnostic excludes ${privateValue}`);
  return record;
};
try {
  const codexModels = [
    { id: "gpt-6.1-sol", name: "Sol 6.1" },
    { id: "gpt-6-astra", name: "Astra", supportsFast: false },
    { id: "gpt-6-sol", name: "Sol", supportsFast: true },
    { id: "gpt-6-luna", name: "Luna" },
    { id: "future-unverified-model", name: "Future", supportsFast: true },
    { id: "gpt-6.1-sol-future", name: "Dated future", supportsFast: false },
  ];
  const plainCodexModels = codexModels.map(({ supportsFast, ...entry }) => entry);
  const capableCodexModels = [
    { id: "gpt-6.1-sol", name: "Sol 6.1", supportsFast: true },
    { id: "gpt-6-astra", name: "Astra", supportsFast: true },
    { id: "gpt-6-sol", name: "Sol", supportsFast: true },
    { id: "gpt-6-luna", name: "Luna", supportsFast: true },
    { id: "future-unverified-model", name: "Future" },
    { id: "gpt-6.1-sol-future", name: "Dated future" },
  ];
  const readyCodex = { id: "owner", label: "Fixture Codex", provider: "codex", ready: true,
    source: "bundled-provider-catalog", entitlementVerified: false, models: codexModels };
  const siwc = { id: "account-00000000-0000-4000-8000-000000000001", label: "Fixture SIWC", provider: "siwc", ready: true,
    source: "provider-account-catalog", entitlementVerified: true,
    models: [{ id: model, name: "Account Fast", supportsFast: true }, { id: "gpt-6-luna", name: "Account Standard", supportsFast: false }, { id: "gpt-6-sol", name: "No account tier" }] };
  for (const provider of [undefined, "codex", "auto", "siwc"]) {
    await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings,
      ...(provider === undefined ? {} : { INFERENCE_BRIDGE_PROVIDER: provider }) } }] }));
    const unavailable = [
      { ...readyCodex, id: "account-00000000-0000-4000-8000-000000000002", ready: false },
      { ...readyCodex, id: "account-00000000-0000-4000-8000-000000000003", source: "provider-account-catalog" },
      { ...readyCodex, id: "account-00000000-0000-4000-8000-000000000004", ready: "true" },
      { ...readyCodex, id: "account-00000000-0000-4000-8000-000000000005", ready: null },
    ];
    const catalog = { source: "subscription-provider-catalog", connections: [readyCodex, siwc, ...unavailable] };
    await invoke({ configure: { catalog } });
    const before = calls, credentialsBefore = (await invoke({ credentialCalls: true })).data.count;
    const advertised = await invoke({ subscriptionModels: true });
    assert.equal(advertised.status, 200, JSON.stringify(advertised));
    assert.deepEqual(advertised.data, { source: "subscription-provider-catalog", connections: [
      { ...readyCodex, models: provider === "siwc" ? plainCodexModels : capableCodexModels },
      siwc,
      ...unavailable.map(row => ({ ...row, models: plainCodexModels })),
    ] }, "only bridge-supported, ready bundled Codex models advertise Fast; existing catalog shape, ordering and SIWC flags survive");
    assert.equal((await invoke({ catalogCalls: true })).data.count, 1, "one existing safe catalog lookup");
    assert.equal((await invoke({ credentialCalls: true })).data.count, credentialsBefore, "capability projection adds no status lookup");
    assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 0, siwc: 0 }, "capability projection never accesses a bearer");
    assert.equal(calls, before, "capability projection adds no provider HTTP");
  }
  console.log("inference bridge Fast catalog checks passed: default/Codex/auto capability, SIWC policy refusal, readiness/provenance gates, unsupported/forged flag removal, unchanged SIWC metadata and existing catalog shape, one safe lookup and no extra auth/network");
  for (const provider of ["codex", "auto"]) {
    await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: provider } }] }));
    await invoke({ configure: {} });
    const standard = await invoke({ bridge: wire({}) });
    assert.equal(standard.data.result.stopReason, "stop");
    const ordinary = structuredClone(lastNative);
    const priority = await invoke({ bridge: wire({ options: { serviceTier: "priority" } }) });
    assert.equal(priority.status, 200, JSON.stringify(priority));
    assert.equal(priority.data.result.stopReason, "stop");
    assert.equal(lastNative.service_tier, "priority", "Codex Fast reaches the actual authenticated serializer");
    const { service_tier, ...unchanged } = lastNative;
    assert.deepEqual(unchanged, ordinary, "Codex Fast changes no reasoning or content fields");
    for (const selectedModel of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      expectedModel = selectedModel;
      const supported = await invoke({ bridge: wire({ modelId: selectedModel, options: { serviceTier: "priority" } }) });
      assert.equal(supported.status, 200, JSON.stringify(supported));
      assert.equal(supported.data.result.stopReason, "stop");
      assert.equal(lastNative.model, selectedModel, "every advertised Codex model reaches its own installed provider model");
      assert.equal(lastNative.service_tier, "priority", "every advertised Codex model admits and serializes Fast");
    }
    expectedModel = model;
    await invoke({ configure: {} });
    const before = calls;
    const rejected = await invoke({ admission: wire({ modelId: "future-unverified-model", options: { serviceTier: "priority" } }) });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error, "inference_bridge_service_tier_unavailable", "Codex rejects unverified models before bearer access");
    assert.equal(calls, before);
    assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 0, siwc: 0 });
  }
  expectedProvider = "siwc";
  for (const provider of ["siwc", "auto"]) {
    await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: provider } }] }));
    await invoke({ configure: { status: { provider: "siwc" } } });
    const standard = await invoke({ bridge: wire({}) });
    assert.equal(standard.data.result.stopReason, "stop");
    const standardWire = structuredClone(lastWire);
    assert.equal(Object.hasOwn(lastNative, "service_tier"), false, "Standard leaves the serialized tier absent");
    await invoke({ nativeProvider: true, siwc: true, context: wire({}).context });
    assert.deepEqual(lastWire, standardWire, "Standard preserves the native installed SDK serializer's exact JSON and headers");
    const priority = await invoke({ bridge: wire({ options: { serviceTier: "priority" } }) });
    assert.equal(priority.status, 200, JSON.stringify(priority));
    assert.equal(priority.data.result.stopReason, "stop");
    assert.equal(lastNative.service_tier, "priority", "priority reaches the installed SDK's serialized API payload");
    assert.equal(lastNative.store, false);
    assert.equal(lastNative.stream, true);
    assert.equal(lastWire.encoding, "identity");
    const { service_tier, ...priorityBody } = lastNative;
    assert.equal(JSON.stringify(priorityBody), standardWire.json, "opting in adds only service_tier to the existing JSON");
    assert.equal(Object.hasOwn(priority.data.result, "responseServiceTier"), false, "requested priority is not a delivered-tier observation");
    await invoke({ bridge: wire({}) });
    assert.deepEqual(lastWire, standardWire, "omission restores the exact Standard request JSON and headers");
    const before = calls;
    for (const value of ["auto", "default", "fast", "flex", "scale", "ultrafast", "Priority", "", null, true, 1, {}, []]) {
      const rejected = await invoke({ admission: wire({ options: { serviceTier: value } }) });
      assert.equal(rejected.data.error, "inference_bridge_input_invalid", "only the explicit priority enum is accepted");
    }
    assert.equal(calls, before, "invalid tiers fail before provider HTTP");
    const terminal = fields => ({ type: "response.completed", fields });
    const tierCases = [
      ...["auto", "default", "flex", "scale", "priority", "fast", "ultrafast"].map(value => ({ name: "observed " + value, fixture: { terminals: [terminal({ model, service_tier: value })] }, expected: value })),
      { name: "priority fallback", fixture: { terminals: [terminal({ model, service_tier: "default" })] }, expected: "default" },
      { name: "incomplete tier", fixture: { terminals: [{ type: "response.incomplete", fields: { model, service_tier: "priority", incomplete_details: { reason: "max_output_tokens" } } }] }, expected: "priority" },
      { name: "created-only tier", fixture: { created: { service_tier: "priority" }, terminals: [terminal({ model })] } },
      { name: "missing tier", fixture: { terminals: [terminal({ model })] } },
      { name: "matching terminal tiers", fixture: { terminals: [terminal({ model, service_tier: "priority" }), terminal({ model, service_tier: "priority" })] }, expected: "priority" },
      { name: "conflicting terminal tiers", fixture: { terminals: [terminal({ model, service_tier: "priority" }), terminal({ model, service_tier: "default" })] } },
      { name: "valid then missing tier", fixture: { terminals: [terminal({ model, service_tier: "priority" }), terminal({ model })] } },
      { name: "valid then malformed tier", fixture: { terminals: [terminal({ model, service_tier: "priority" }), terminal({ model, service_tier: null })] } },
      { name: "malformed then valid tier", fixture: { terminals: [terminal({ model, service_tier: null }), terminal({ model, service_tier: "priority" })] } },
      { name: "unrelated event tier", fixture: { extraEvents: [{ type: "response.fixture_metadata", response: { service_tier: "priority" } }], terminals: [terminal({ model })] } },
      { name: "wrong tier property", fixture: { terminals: [terminal({ model, responseServiceTier: "priority" })] } },
      { name: "valid tier and malformed model", fixture: { terminals: [terminal({ model: null, service_tier: "priority" })] }, expected: "priority", invalidModel: true },
      ...[null, 42, {}, [], "", "Priority", "priority ", "PRIVATE@malformed.invalid", "x".repeat(129)].map(value => ({ name: "malformed tier", fixture: { terminals: [terminal({ model, service_tier: value })] } })),
    ];
    for (const { name, fixture, expected, invalidModel = false } of tierCases) {
      responseModelFixture = fixture;
      const result = await invoke({ bridge: wire({ options: { serviceTier: "priority" } }) });
      assert.equal(result.status, 200, name);
      assert.equal(result.data.result.responseServiceTier, expected, name);
      assert.equal(Object.hasOwn(result.data.result, "responseServiceTier"), expected !== undefined, name);
      assert.equal(result.data.result.responseModel, invalidModel ? undefined : model, "tier validity leaves model observations independent");
      assert(result.data.events.filter(event => !["done", "error"].includes(event.type)).every(event => !Object.hasOwn(event.partial, "responseServiceTier")), "delivered tier appears only on terminal output");
    }
    responseModelFixture = { created: { service_tier: "priority" } };
    const history = await invoke({ bridge: wire({ context: { messages: [{ role: "user", content: "Earlier turn", timestamp: 0 }, { ...standard.data.result, responseServiceTier: "priority", timestamp: 1 }, { role: "user", content: "hello", timestamp: 2 }] } }) });
    assert.equal(Object.hasOwn(history.data.result, "responseServiceTier"), false, "assistant history cannot supply delivered-tier evidence");
    responseModelFixture = { terminals: [terminal({ model, service_tier: "priority" })] };
    const adapted = await invoke({ prompt: "hello", fastMode: true });
    assert.equal(adapted.data.result.responseServiceTier, "priority", "the genuine OS adapter preserves observed tier metadata");
    assert.equal(lastNative.service_tier, "priority", "the OS handle's captured Fast option reaches the serializer");
    const delivered = await invoke({ prompt: "hello" });
    assert.equal(delivered.data.result.responseServiceTier, "priority", "observed delivery does not require a requested tier");
    assert.equal(Object.hasOwn(lastNative, "service_tier"), false);
    responseModelFixture = undefined;
    await invoke({ configure: { status: { provider: "siwc" }, retryLimit: 1 } });
    retryResponse = true;
    const retried = await invoke({ bridge: wire({ options: { serviceTier: "priority" } }) });
    assert.equal(retried.data.result.stopReason, "stop");
    assert.equal((await invoke({ fetchAttempts: true })).data.count, 2, "real SDK retry makes exactly two HTTP attempts");
    assert.equal(lastNative.service_tier, "priority", "the selected tier survives the provider retry");
    assert.equal(Object.hasOwn(retried.data.result, "responseServiceTier"), false, "retry with absent metadata retains no prior call's observation");
    const tool = { name: "read_health", description: "Read only", parameters: { type: "object", properties: {}, additionalProperties: false } };
    const first = await invoke({ bridge: wire({ context: { messages: [{ role: "user", content: "use_read_tool", timestamp: 1 }], tools: [tool] }, options: { serviceTier: "priority" } }) });
    assert.equal(first.data.result.stopReason, "toolUse");
    assert.equal(lastNative.service_tier, "priority");
    const called = first.data.result.content.find(block => block.type === "toolCall");
    const next = await invoke({ bridge: wire({ context: { messages: [{ role: "system", content: "Use declared tools", toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "use_read_tool", timestamp: 1 }, first.data.result, { role: "toolResult", toolCallId: called.id, toolName: called.name, content: [{ type: "text", text: "READ_ONLY_OK" }], isError: false, timestamp: 3 }] }, options: { serviceTier: "priority" } }) });
    assert.equal(next.data.result.stopReason, "stop");
    assert.equal(lastNative.service_tier, "priority", "the next tool-result request retains the explicit Fast setting");
    assert(lastNative.input.some(item => item.type === "function_call_output" && item.output.includes("READ_ONLY_OK")));
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "tier metadata adds no success diagnostics");
  }
  console.log("inference bridge Fast checks passed: strict priority and allowlisted Codex/SIWC transport, exact installed SDK serialization, Standard parity, terminal tier allowlist, requested/actual separation, model independence, spoof/malformed/conflict refusal, tool results and retry isolation");
  expectedProvider = "codex";
  for (const provider of ["", "unknown", "openai", "Codex"]) {
    await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: provider } }] }));
    const before = calls, credentialsBefore = (await invoke({ credentialCalls: true })).data.count;
    const denied = await invoke({admission:wire({})});
    assert.equal(denied.status, 400, "unknown provider must fail configuration validation");
    assert.equal(denied.data.error, "inference_bridge_not_configured");
    assert.equal(calls, before);
    assert.equal((await invoke({ credentialCalls: true })).data.count, credentialsBefore, "unknown provider denied before Credentials status");
  }
  await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: "codex" } }] }));
  const explicitCodex = await invoke({ prompt: "OS_OK" });
  assert.equal(explicitCodex.data.result.content[0]?.text, "OS_OK");
  assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 1, siwc: 0 }, "explicit Codex keeps the Codex credential accessor");
  await invoke({ configure: { status: { provider: "siwc", inferenceReady: false, codexInferenceReady: true, siwcInferenceReady: false } } });
  const independentCodex=await invoke({prompt:"OS_OK"});assert.equal(independentCodex.status,200,JSON.stringify(independentCodex));assert.equal(independentCodex.data.result.content[0]?.text,"OS_OK","native bridge relies on its actual native grant, not ordinary selection");
  expectedProvider = "siwc";
  await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: "siwc" } }] }));
  await invoke({ configure: { status: { provider: "codex", inferenceReady: false } } });
  const explicitSiwc = await invoke({ prompt: "OS_OK" });
  assert.equal(explicitSiwc.status, 200, JSON.stringify(explicitSiwc.data));
  assert.equal(explicitSiwc.data.result.content[0]?.text, "OS_OK", "explicit SIWC uses its existing direct grant even when the selected Codex profile is not ready");
  assert.equal(explicitSiwc.data.result.provider, "openai");
  assert.equal(explicitSiwc.data.result.usage.cost.total, 0);
  assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 0, siwc: 1 });
  assert.equal(lastWire.encoding, "identity");
  assert.equal(lastWire.headers["chatgpt-account-id"], undefined);
  assert.equal(lastWire.headers["openai-beta"], undefined);
  assert.equal(lastNative.max_output_tokens, undefined, "SIWC provider preserves its contract excluding max_output_tokens");
  expectedProvider = "codex";
  await mf.setOptions(convertV4MiniflareOptions({ workers: [client, server] }));
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
  assert.equal((await invoke({ accessCalls: true })).data.siwc, 0, "Codex failure never invokes the available legacy grant automatically");
  await checkDiagnostic({ credentialExpiry:"unavailable",responseEdgeColo:"HKG",responseServer:"cloudflare",phase: "response", credentialAccessFailed: false, fetchAttempted: true, responseReceived: true, status: 403, category: "permission_denied", contentType: "json", challenge: false, requestEndpointExpected: true, requestAuthorizationPresent: true, requestAccountPresent: true, requestContentTypePresent: true, requestAcceptPresent: true, payloadStoreFalse: true, payloadStreamTrue: true, payloadInputArray: true, payloadToolSchemaValid: true, requestWireEncoding: lastWire.encoding, requestWireKind: lastWire.encoding === "zstd" ? "bytes" : "string", requestWireByteLength: lastWire.byteLength, responseRedirected: false, responseFinalEndpointExpected: true, cfErrorType: null, cfErrorOriginPresent: false, ...Object.fromEntries(htmlKeys.map(key => [key, null])), htmlTruncated: null });
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
  for (const [claim, expected] of [[1001,"future"],[1000,"expired"],[999,"expired"],["PRIVATE-expiry","unavailable"],[null,"unavailable"],[Number.MAX_VALUE,"unavailable"]]) {
    const token="e30."+Buffer.from(JSON.stringify({exp:claim,sub:"PRIVATE-subject"})).toString("base64url")+".PRIVATE-signature";
    assert.equal((await invoke({checkExpiry:{token}})).data.expiry,expected);
  }
  for (const token of ["PRIVATE-token","a.b.c.d","e30.bm90LWpzb24.signature"]) assert.equal((await invoke({checkExpiry:{token}})).data.expiry,"unavailable");
  for (const [edgeColo,server,expectedColo,expectedServer] of [["HKG","cloudflare","HKG","cloudflare"],["LAX","nginx","LAX","nginx"],["NRT","envoy","NRT","envoy"],["PRIVATE-colo","nginx/PRIVATE-version",null,null],["HK","PRIVATE-server",null,null],["hkG","other",null,"other"],["HKG PRIVATE","missing",null,"missing"]]) {
    const record=(await invoke({projectDiagnostic:{...baseObservation,responseMetadata:{edgeColo,server},credentialExpiry:"future"}})).data;
    assert.equal(record.responseEdgeColo,expectedColo);assert.equal(record.responseServer,expectedServer);assert.equal(record.credentialExpiry,"future");
    assert(!JSON.stringify(record).includes("PRIVATE"));
  }
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
  expectedProvider = "siwc";
  for (const encoding of ["native", "identity"]) {
    await mf.setOptions(convertV4MiniflareOptions({ workers: [client, { ...server, bindings: { ...server.bindings, INFERENCE_BRIDGE_PROVIDER: "siwc", INFERENCE_BRIDGE_REQUEST_ENCODING: encoding } }] }));
    for (const status of [{ siwcInferenceReady: false }, { siwcInferenceReady: null }, { siwcInferenceReady: "true" }]) {
      await invoke({ configure: { status } });
      const before = calls, rejected = await invoke({admission:wire({})});
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.error, "inference_bridge_account_unavailable");
      assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 0, siwc: 0 });
      assert.equal(calls, before, "inactive or absent direct grant denies before token access and provider HTTP");
    }
    await invoke({ configure: {} });
    const plain = await invoke({ prompt: "OS_OK" });
    assert.equal(plain.data.result.content[0]?.text, "OS_OK");
    assert.equal(plain.data.result.stopReason, "stop");
    assert.equal(plain.data.result.usage.totalTokens, 7);
    assert.equal(lastWire.encoding, "identity", "Codex encoding selection does not alter the API provider transport");
    const metadataRequest = structuredClone(lastWire);
    const terminal = fields => ({ type: "response.completed", fields });
    const modelCases = [
      { name: "completed server model", fixture: { terminals: [terminal({ model })] }, expected: model },
      { name: "different requested/server model", fixture: { terminals: [terminal({ model: "gpt-6-luna" })] }, expected: "gpt-6-luna" },
      { name: "dated server model", fixture: { terminals: [terminal({ model: "gpt-6.1-sol-2026-10-01" })] }, expected: "gpt-6.1-sol-2026-10-01" },
      { name: "minimum-length model ID", fixture: { terminals: [terminal({ model: "m" })] }, expected: "m" },
      { name: "maximum-length model ID", fixture: { terminals: [terminal({ model: "m".repeat(128) })] }, expected: "m".repeat(128) },
      { name: "incomplete server model", fixture: { terminals: [{ type: "response.incomplete", fields: { model, incomplete_details: { reason: "max_output_tokens" } } }] }, expected: model, stop: "length" },
      { name: "created model is provisional", fixture: { created: { model: "gpt-6-luna" }, terminals: [terminal({ model })] }, expected: model },
      { name: "created-only model", fixture: { created: { model } } },
      { name: "omitted model", fixture: {} },
      { name: "conflicting terminal models", fixture: { terminals: [terminal({ model }), terminal({ model: "gpt-6-luna" })] } },
      { name: "valid then missing terminal model", fixture: { terminals: [terminal({ model }), terminal({})] } },
      { name: "valid then malformed terminal model", fixture: { terminals: [terminal({ model }), terminal({ model: "PRIVATE@malformed.invalid" })] } },
      { name: "malformed then valid terminal model", fixture: { terminals: [terminal({ model: null }), terminal({ model })] } },
      { name: "unrelated stream-event model spoof", fixture: { extraEvents: [{ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "", response: { model } }, { type: "response.fixture_metadata", response: { model } }] } },
      { name: "wrong metadata property", fixture: { terminals: [terminal({ responseModel: model })] } },
      ...[null, 42, {}, [], "", " ", "m".repeat(129), "PRIVATE@malformed.invalid", "https://PRIVATE.invalid/model", "line\nbreak", "模型"].map(value => ({ name: "malformed model value", fixture: { terminals: [terminal({ model: value })] } }))
    ];
    for (const { name, fixture, expected, stop = "stop" } of modelCases) {
      responseModelFixture = fixture;
      const before = calls, result = await invoke({ prompt: "OS_OK" });
      assert.equal(result.status, 200, name);
      assert.equal(result.data.result.content[0]?.text, "OS_OK", name);
      assert.equal(result.data.result.stopReason, stop, name);
      assert.equal(result.data.result.model, model, "message.model remains the configured/requested ID");
      assert.equal(lastNative.model, model, "server observation does not change the request or model allowlist");
      assert.deepEqual(lastWire, metadataRequest, "model observation preserves the exact provider request body and headers");
      assert.equal(result.data.result.responseModel, expected, name);
      assert.equal(Object.hasOwn(result.data.result, "responseModel"), expected !== undefined, name);
      assert.equal(calls, before + 1, "metadata observation makes no additional provider request");
      assert(result.data.events.filter(event => !["done", "error"].includes(event.type)).every(event => !Object.hasOwn(event.partial, "responseModel")), "SIWC metadata is projected only on the terminal message");
    }
    responseModelFixture = { created: { model } };
    const historySpoof = await invoke({ context: { messages: [{ role: "user", content: "Earlier synthetic turn", timestamp: 0 }, { ...plain.data.result, responseModel: model, timestamp: 1 }, { role: "user", content: "OS_OK", timestamp: 2 }] } });
    assert.equal(historySpoof.data.result.content[0]?.text, "OS_OK");
    assert.equal(Object.hasOwn(historySpoof.data.result, "responseModel"), false, "supplied assistant history is not a server-model observation");
    responseModelFixture = undefined;
    assert.equal(Object.hasOwn((await invoke({ prompt: "OS_OK" })).data.result, "responseModel"), false, "server model state is private to one call");
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "model observations and malformed metadata add no success logs");
    console.log(`inference bridge SIWC terminal-model check passed (${encoding}): ${modelCases.length} actual SDK SSE cases, requested/observed separation, omitted/malformed/conflicting metadata, incomplete output, spoof/history refusal, cross-call isolation and no extra request/log`);
    const tool = { name: "read_health", description: "Read only", parameters: { type: "object", properties: {}, additionalProperties: false } };
    const first = await invoke({ prompt: "use_read_tool", tools: [tool] });
    assert.equal(first.data.result.stopReason, "toolUse");
    const called = first.data.result.content.find(block => block.type === "toolCall");
    const next = await invoke({ context: { messages: [{ role: "system", content: "Use declared tools", toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "use_read_tool", timestamp: 1 }, first.data.result, { role: "toolResult", toolCallId: called.id, toolName: called.name, content: [{ type: "text", text: "READ_ONLY_OK" }], isError: false, timestamp: 3 }] } });
    assert.equal(next.data.result.content[0]?.text, "BRIDGE_OK");
    assert(lastNative.input.some(item => item.type === "function_call_output" && item.output.includes("READ_ONLY_OK")));
    assert.deepEqual((await invoke({ diagnostics: true })).data, []);
    const beforeRejected = calls;
    for (const input of [{ actor: { id: "other@example.invalid" } }, { config: { model: "other-model" } }, { direct: wire({ accountId: "other" }) }, { direct: wire({ options: { headers: { authorization: "forbidden" } } }) }, { direct: wire({ context: { messages: [{ role: "user", content: "x".repeat(1100000), timestamp: 1 }] } }) }]) assert.equal((await invoke(input)).status, 400);
    assert.equal(calls, beforeRejected);
    for (const [prompt, expected] of [["provider_denial", { status: 403, category: "permission_denied", contentType: "json" }], ["provider_challenge", { status: 403, category: "upstream_blocked", contentType: "html", challenge: true }], ["sse_failure", { status: 200, category: "success", contentType: "sse" }]]) {
      await invoke({ configure: {} });const before = calls;
      const denied = await invoke({ prompt });
      assert.equal(denied.data.result.errorMessage, "inference_bridge_provider_error");
      assert.equal(denied.data.result.stopReason, "error");
      assert(!JSON.stringify(denied.data).includes("PRIVATE"));
      assert(!JSON.stringify(denied.data).includes("secret raw provider failure"));
      assert.equal(calls, before + 1);
      assert.deepEqual((await invoke({ accessCalls: true })).data, { codex: 0, siwc: 1 });
      await checkDiagnostic({ provider: "siwc", phase: "response", requestEndpointExpected: true, responseFinalEndpointExpected: true, requestAuthorizationPresent: true, requestAccountPresent: false, requestWireEncoding: "identity", requestWireKind: "string", ...expected });
    }
    for (const [url, expected] of [["https://api.openai.com/v1/responses", true], ["https://chatgpt.com/backend-api/codex/responses", false], ["https://PRIVATE.invalid/PRIVATE", false], ["PRIVATE-invalid-url", null]]) {
      await invoke({ configure: { responseMetadata: { url } } });
      await invoke({ prompt: "provider_denial" });
      await checkDiagnostic({ provider: "siwc", responseFinalEndpointExpected: expected });
    }
    await invoke({ configure: { mode: "credential_failure" } });
    const beforeCredentialFailure = calls, failure = await invoke({});
    assert.equal(failure.data.result.errorMessage, "inference_bridge_provider_error");
    assert.equal(calls, beforeCredentialFailure);
    await checkDiagnostic({ provider: "siwc", phase: "credential", credentialAccessFailed: true, fetchAttempted: false, status: null });
    await invoke({ configure: {} });
    for (const prompt of ["bridge_frame_limit", "bridge_total_limit"]) {
      const before = calls, limited = await invoke({ prompt });
      assert.equal(limited.data.result.stopReason, "error");
      assert.equal(limited.data.result.errorMessage, "inference_bridge_failed", "actual provider output exceeding bridge limits must fail before adapter framing");
      assert.equal(calls, before + 1);
    }
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "bridge output-limit failure is not mislabeled as provider denial");
    const beforeAbort = (await invoke({ signalCount: true })).data.count;
    const aborted = await invoke({ abort: true, prompt: "hold_stream" });
    assert.equal(aborted.data.result.stopReason, "aborted");
    let afterAbort = (await invoke({ signalCount: true })).data.count;
    for (let attempt = 0; afterAbort === beforeAbort && attempt < 10; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); afterAbort = (await invoke({ signalCount: true })).data.count; }
    assert.equal(afterAbort, beforeAbort + 1);
    const timedOut = await invoke({ prompt: "hold_stream" });
    assert.equal(timedOut.data.result.stopReason, "aborted");
    for (const prompt of ["invalid_utf8", "oversized", "invalid_version"]) assert.equal((await invoke({ fault: true, prompt })).data.result.stopReason, "error");
    assert.deepEqual((await invoke({ diagnostics: true })).data, [], "SIWC cancellation, deadline and bridge frame errors emit no diagnostic");
    console.log(`inference bridge SIWC check passed (${encoding} Codex encoding setting): direct grant, API endpoint, OS_OK, tool roundtrip, inactive/grant refusal, allowlists/input limits, sanitization, fixed diagnostics, cancel and deadline`);
  }
  expectedProvider = "codex";
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
