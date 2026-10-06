import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const directory = await mkdtemp(join(tmpdir(), "pi-image-check-"));
const entry = join(directory, "fixture.js"), bundle = join(directory, "worker.js");
const toolPath = fileURLToPath(new URL("../../workers/pi/image-tool.js", import.meta.url));
const registryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-durable"));
await writeFile(entry, `import { DurableObject } from 'cloudflare:workers';
import { createRegistry } from ${JSON.stringify(registryPath)};
import { installImageTool, serveImageAsset } from ${JSON.stringify(toolPath)};
export class ImageFixture extends DurableObject {
 async fetch(request) {
  const data=await request.json(), registry=createRegistry();
  const env={...this.env,...data.env};
  const controller=new AbortController(),ledger=data.abortAfterClaim?{transaction:async callback=>{const result=await this.ctx.storage.transaction(callback);controller.abort();return result},put:(...args)=>this.ctx.storage.put(...args)}:this.ctx.storage;
  if(data.ledger) return Response.json([...await this.ctx.storage.list({prefix:'image-job:'})].map(([,row])=>row));
  if(data.seedDispatch) {
   const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
   await this.ctx.storage.put('image-job:'+await hash(JSON.stringify(['tenant-a',data.operationId])),{status:'dispatching',assetId:crypto.randomUUID(),tenantId:'tenant-a',promptDigest:await hash('Synthetic fixture')});
   return Response.json({seeded:true});
  }
  if(data.seedLegacy) {
   const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
   const assetId=crypto.randomUUID(),bytes=Uint8Array.from(atob(data.seedLegacy),char=>char.charCodeAt(0));
   const objectKey='images/'+await hash('tenant-a')+'/'+assetId;
   if(!data.seedMissingObject)await env.IMAGE_ASSETS.put(objectKey,bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{tenantId:'tenant-a',assetId}});
   await this.ctx.storage.put('image-job:'+await hash(JSON.stringify(['tenant-a',data.operationId])),{status:data.seedStatus??'ready',assetId,tenantId:'tenant-a',promptDigest:await hash('Synthetic fixture'),bytes:bytes.byteLength,mediaType:'image/png'});
   return Response.json({assetId,objectKey});
  }
  if(data.r2Failure) env.IMAGE_ASSETS={head:key=>this.env.IMAGE_ASSETS.head(key),put:async()=>{throw Error('PRIVATE-KEY-MARKER')}};
  const caller={tenantId:data.tenantId??'tenant-a',sourceOperationId:data.operationId??'source-a',explicitRequest:data.explicitRequest??'/image synthetic fixture'};
  const executeImage=installImageTool({registry,env,ledger,resolveCaller:async(api,context)=>{if(data.callerThrow)throw Error('PRIVATE-KEY-MARKER');return data.denied||context?.marker!=='native-context'?null:caller},generate:data.codexTransport?async({signal})=>{if(data.codexAuthFailure)throw Error('image_auth_needed');if(data.codexFailure){const error=Error(data.codexFailure.code);error.diagnostic=data.codexFailure.diagnostic;throw error;}return fetch('https://codex-image.fixture.invalid/generate',{signal})}:undefined});
  const tool=registry.snapshot().tools().find(row=>row.tool.name==='generate_image')?.tool;
  if(data.inspect) return Response.json(tool?{name:tool.name,replay:tool.replay,executionMode:tool.executionMode,parameters:tool.parameters}:null);
  if(data.asset) return serveImageAsset(new Request('https://image.fixture.invalid/assets/'+data.asset),env,'session' in data?data.session:{tenantId:data.tenantId??'tenant-a'});
  if(data.direct) return Response.json(typeof executeImage==='function'?await executeImage(data.args??{prompt:'Synthetic fixture'},Object.hasOwn(data,'directCaller')?data.directCaller:caller,{abortSignal:controller.signal}):{missingExecutor:true});
  if(data.readReceipt) return Response.json(typeof executeImage?.resultFor==='function'?await executeImage.resultFor(Object.hasOwn(data,'directCaller')?data.directCaller:caller):{missingReader:true});
  return Response.json(tool?await tool.execute(data.args??{prompt:'Synthetic fixture'}, {callId:data.callId??'call-a'}, {marker:'native-context',abortSignal:controller.signal}):{missing:true});
 }
}
export default {fetch(request,env){return env.JOBS.getByName('fixture').fetch(request)}};`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], logLevel: "silent" });
const webp = new Uint8Array([82,73,70,70,22,0,0,0,87,69,66,80,86,80,56,32,10,0,0,0,0,0,0,157,1,42,0,4,0,4]);
const pngChunk = (kind, data) => {
  const chunk=Buffer.alloc(data.length+12); chunk.writeUInt32BE(data.length); chunk.write(kind,4); data.copy(chunk,8);
  let crc=0xffffffff; for(const byte of chunk.subarray(4,-4)){crc^=byte; for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4); return chunk;
};
const pngFor=(width,height)=>{
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8]=8;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(Buffer.alloc((width+1)*height))),pngChunk('IEND',Buffer.alloc(0))]);
};
const png=pngFor(1024,1024), rectangularPng=pngFor(1536,1024);
const webpFor=(width,height,canvas)=>{
  const frame=Buffer.from(webp);frame.writeUInt16LE(width,26);frame.writeUInt16LE(height,28);
  if(!canvas)return frame;
  const extended=Buffer.alloc(18);extended.write('VP8X');extended.writeUInt32LE(10,4);extended.writeUIntLE(canvas[0]-1,12,3);extended.writeUIntLE(canvas[1]-1,15,3);
  const value=Buffer.concat([frame.subarray(0,12),extended,frame.subarray(12)]);value.writeUInt32LE(value.length-8,4);return value;
};
let mode = "normal", calls = 0, codexCalls = 0;
const outbound = async request => {
  calls++;
  if(request.url==='https://codex-image.fixture.invalid/generate') {
    codexCalls++;
    if(mode==='codex-auth') return new Response(null,{status:401});
    const image=Buffer.from(mode==='png-non-square'?rectangularPng:png); if(mode==='png-zero-size')image.writeUInt32BE(0,16);
    if(mode==='png-too-wide')image.writeUInt32BE(4097,16);
    if(mode==='png-magic')image[0]=0;
    return Response.json({data:[{b64_json:image.toString('base64')}],secret:'PRIVATE-KEY-MARKER'});
  }
  assert.equal(request.url, "https://api.openai.com/v1/images/generations");
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-image-api-key-at-least-32");
  const body = await request.json();
  assert.deepEqual(Object.keys(body).sort(), ["background","model","n","output_compression","output_format","prompt","quality","size"]);
  assert.equal(body.model, "gpt-image-2.5-flare"); assert.equal(body.n, 1); assert.equal(body.quality, "low"); assert.equal(body.size, "1024x1024");
  if (mode === "network") throw Error("PRIVATE-KEY-MARKER");
  if (mode === "delayed") await new Promise(resolve=>setTimeout(resolve,40));
  if (mode === "oversize") return new Response("x".repeat(8*1024*1024+1));
  if (mode === "decoded-large") return Response.json({data:[{b64_json:Buffer.alloc(5*1024*1024+1).toString('base64')}]});
  if (mode === "redirect") return new Response(null,{status:302,headers:{location:'https://untrusted.invalid/image'}});
  if (mode === "bad-image") return Response.json({data:[{b64_json:Buffer.from('not webp').toString('base64')}]});
  const image=mode==='webp-non-square'?webpFor(1536,1024,[1536,1024]):mode==='webp-canvas-mismatch'?webpFor(512,1024,[1024,1024]):mode==='webp-too-wide'?webpFor(4097,1024):mode==='webp-zero-size'?webpFor(0,1024):Buffer.from(webp);
  return Response.json({ data: [{ b64_json: image.toString("base64") }], secret: "PRIVATE-KEY-MARKER" });
};
const mf = new Miniflare(convertV4MiniflareOptions({
  name: "image-check", modulesRoot: directory, modules: [{type:"ESModule",path:bundle}], compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],
  bindings: { IMAGE_ENABLED:"true", IMAGE_PROVIDER:"api", IMAGE_PAID_APPROVED:"true", IMAGE_OPENAI_API_KEY:"synthetic-image-api-key-at-least-32", PUBLIC_ORIGIN:"https://image.fixture.invalid", TENANT_ID:"tenant-a" },
  durableObjects: { JOBS:{className:"ImageFixture",useSQLite:true} }, r2Buckets:{IMAGE_ASSETS:"image-fixture"}, outboundService:outbound,
}));
const invoke = body => mf.dispatchFetch("https://image.fixture.invalid/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const run = async body => {
  const result=await (await invoke(body)).json();
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE-KEY-MARKER|b64_json|synthetic-image-api-key/);
  return result?.content?JSON.parse(result.content[0].text):result;
};
try {
  const registration=await (await invoke({inspect:true})).json();
  assert.equal(registration.name,"generate_image"); assert.equal(registration.replay,"unsafe"); assert.equal(registration.executionMode,"sequential");
  assert.equal(registration.parameters.additionalProperties,false);
  for(const args of [{prompt:''},{prompt:' '},{prompt:'x'.repeat(2001)},{prompt:'A\0B'},{prompt:'Synthetic',model:'caller-model'},{prompt:'Synthetic',tenantId:'tenant-b'}]) assert.equal((await run({args})).status,"failed");
  assert.equal((await run({denied:true})).status,"failed");
  assert.equal((await run({explicitRequest:'Explain this picture'})).status,"failed");
  assert.equal((await run({env:{IMAGE_ENABLED:'false'}})).status,"failed");
  assert.equal((await run({env:{IMAGE_OPENAI_API_KEY:''}})).status,"failed");
  assert.equal((await run({env:{IMAGE_PAID_APPROVED:'false'}})).status,"failed");
  assert.equal((await run({env:{IMAGE_PROVIDER:''}})).status,"failed");
  assert.equal((await run({env:{IMAGE_PROVIDER:'caller-provider'}})).status,"failed");
  assert.equal((await run({env:{IMAGE_PROVIDER:'codex'}})).code,"image_auth_needed");
  assert.equal((await run({env:{IMAGE_MODEL:'caller-model'}})).status,"failed");
  assert.equal(calls,0);
  const first=await run({}); assert.equal(first.status,"ready"); assert.equal(first.mediaType,"image/webp"); assert.equal(first.bytes,webp.byteLength); assert.equal(calls,1);
  const repeated=await run({callId:'different-call'}); assert.deepEqual(repeated,first); assert.equal(calls,1);
  assert.equal((await run({args:{prompt:'A different prompt'}})).status,"failed"); assert.equal(calls,1);
  const asset=await invoke({asset:first.assetId}); assert.equal(asset.status,200); assert.equal(asset.headers.get('cache-control'),'private, no-store'); assert.deepEqual(new Uint8Array(await asset.arrayBuffer()),webp);
  assert.equal((await invoke({asset:first.assetId,session:null})).status,403);
  assert.equal((await invoke({asset:first.assetId,session:{tenantId:'tenant-b'}})).status,403);
  assert.equal((await invoke({asset:first.assetId,session:{tenantId:'tenant-b'},env:{TENANT_ID:'tenant-b'}})).status,404);
  const second=await run({tenantId:'tenant-b',operationId:'source-b',env:{TENANT_ID:'tenant-b'}}); assert.equal(second.status,'ready'); assert.notEqual(second.assetId,first.assetId);
  assert.equal((await invoke({asset:second.assetId,session:{tenantId:'tenant-a'},env:{TENANT_ID:'tenant-a'}})).status,404);
  mode='network'; const unknown=await run({operationId:'network'}); assert.equal(unknown.status,'unknown'); const before=calls;
  assert.deepEqual(await run({operationId:'network',callId:'fresh-call'}),unknown); assert.equal(calls,before);
  for(const kind of ['oversize','decoded-large','redirect','bad-image']) {mode=kind; assert.notEqual((await run({operationId:kind})).status,'ready'); const before=calls; await run({operationId:kind,callId:'fresh-call'}); assert.equal(calls,before);}
  mode='normal'; const lost=await run({operationId:'r2-failed',r2Failure:true}); assert.equal(lost.status,'unknown'); const afterLoss=calls;
  assert.deepEqual(await run({operationId:'r2-failed'}),lost); assert.equal(calls,afterLoss);
  await invoke({seedDispatch:true,operationId:'restart-intent'}); const afterIntent=calls;
  assert.equal((await run({operationId:'restart-intent'})).status,'unknown'); assert.equal(calls,afterIntent,'Persisted dispatch intent cannot replay a paid request');
  mode='delayed'; const beforeConcurrent=calls; const concurrent=await Promise.all([run({operationId:'parallel'}),run({operationId:'parallel',callId:'another'})]);
  assert.equal(calls,beforeConcurrent+1); assert.ok(concurrent.some(row=>row.status==='ready'));
  assert.equal((await run({operationId:'parallel'})).status,'ready'); assert.equal(calls,beforeConcurrent+1);
  mode='normal'; const codexEnv={IMAGE_PROVIDER:'codex',IMAGE_MODEL:'gpt-image-2',IMAGE_OPENAI_API_KEY:'',IMAGE_PAID_APPROVED:'false'};
  const pngResult=await run({operationId:'codex-png',codexTransport:true,env:codexEnv}); assert.equal(pngResult.status,'ready'); assert.equal(pngResult.mediaType,'image/png'); assert.equal(pngResult.bytes,png.length); assert.equal(codexCalls,1);
  const pngAsset=await invoke({asset:pngResult.assetId}); assert.equal(pngAsset.headers.get('content-type'),'image/png'); assert.deepEqual(Buffer.from(await pngAsset.arrayBuffer()),png);
  const afterPng=calls; assert.deepEqual(await run({operationId:'codex-png',codexTransport:true,env:codexEnv}),pngResult); assert.equal(calls,afterPng);
  assert.equal((await run({operationId:'codex-no-profile',codexTransport:true,codexAuthFailure:true,env:codexEnv})).code,'image_auth_needed'); assert.equal(calls,afterPng);
  mode='png-non-square';const rectangular=await run({operationId:'png-non-square',codexTransport:true,env:codexEnv});assert.equal(rectangular.status,'ready','A valid non-square PNG must survive image validation');assert.equal(rectangular.width,1536);assert.equal(rectangular.height,1024);
  for(const kind of ['codex-auth','png-zero-size','png-too-wide','png-magic']){mode=kind;const failed=await run({operationId:kind,codexTransport:true,env:codexEnv});assert.equal(failed.status,'failed');if(kind==='codex-auth')assert.equal(failed.code,'image_auth_needed');const before=calls;await run({operationId:kind,codexTransport:true,env:codexEnv});assert.equal(calls,before);}
  mode='webp-non-square';const rectangularWebp=await run({operationId:'webp-non-square'});assert.equal(rectangularWebp.status,'ready');assert.equal(rectangularWebp.width,1536);assert.equal(rectangularWebp.height,1024);
  for(const kind of ['webp-canvas-mismatch','webp-zero-size','webp-too-wide']){mode=kind;assert.equal((await run({operationId:kind})).status,'failed',kind+' must be rejected');}
  mode='normal'; const beforeInjectedApi=codexCalls; assert.equal((await run({operationId:'api-injection',codexTransport:true})).mediaType,'image/webp'); assert.equal(codexCalls,beforeInjectedApi,'API mode must ignore an injected Codex transport');
  const beforeAbort=calls; assert.equal((await run({operationId:'abort-after-claim',abortAfterClaim:true})).status,'unknown'); assert.equal(calls,beforeAbort,'Cancellation after durable claim must not dispatch generation');
  assert.equal((await run({operationId:'abort-after-claim'})).status,'unknown'); assert.equal(calls,beforeAbort,'A cancelled durable claim must never replay generation');
  const beforeDirect=calls;const direct=await run({direct:true,callerThrow:true,operationId:'direct'});assert.equal(direct.status,'ready','The server executor must not need a Pi caller');assert.equal(calls,beforeDirect+1);
  assert.deepEqual(await run({operationId:'direct'}),direct);assert.equal(calls,beforeDirect+1,'Pi and direct calls must share the source job');
  assert.equal((await run({direct:true,directCaller:null,operationId:'denied-direct'})).code,'image_caller_denied');
  assert.equal((await run({direct:true,operationId:'paid-direct',env:{IMAGE_PAID_APPROVED:'false'}})).code,'image_not_configured');
  assert.equal((await run({callerThrow:true,operationId:'caller-throws'})).code,'image_caller_denied');assert.equal(calls,beforeDirect+1);
  const permissionDiagnostic={phase:'image',status:403,category:'permission_denied',contentType:'json',requestId:'fixture-request',rayId:null,challenge:false};
  const rejected=await run({operationId:'codex-permission',codexTransport:true,env:codexEnv,codexFailure:{code:'image_permission_denied',diagnostic:{...permissionDiagnostic,rawBody:'PRIVATE-KEY-MARKER',authorization:'PRIVATE-KEY-MARKER'}}});
  assert.equal(rejected.status,'failed');assert.equal(rejected.code,'image_permission_denied');assert.deepEqual(rejected.diagnostic,permissionDiagnostic,'Only bounded provider diagnostics may enter image receipts');
  assert.deepEqual(await run({operationId:'codex-permission',codexTransport:true,env:codexEnv}),rejected);assert.equal(calls,beforeDirect+1,'Known permission denial must not replay generation');
  const blockedDiagnostic={...permissionDiagnostic,category:'upstream_blocked',contentType:'html',rayId:'fixture-ray',challenge:true};
  const blocked=await run({operationId:'codex-blocked',codexTransport:true,env:codexEnv,codexFailure:{code:'image_upstream_blocked',diagnostic:blockedDiagnostic}});assert.equal(blocked.status,'failed');assert.equal(blocked.code,'image_upstream_blocked');assert.deepEqual(blocked.diagnostic,blockedDiagnostic);
  const unavailableDiagnostic={...permissionDiagnostic,status:503,category:'upstream_error'};
  const unavailable=await run({operationId:'codex-unavailable',codexTransport:true,env:codexEnv,codexFailure:{code:'codex_image_http_503',diagnostic:unavailableDiagnostic}});assert.equal(unavailable.status,'unknown');assert.equal(unavailable.code,'codex_image_http_503');assert.deepEqual(unavailable.diagnostic,unavailableDiagnostic);
  const malformed=await run({operationId:'codex-malformed-diagnostic',codexTransport:true,env:codexEnv,codexFailure:{code:'PRIVATE-KEY-MARKER',diagnostic:{...permissionDiagnostic,requestId:'https://credential.invalid/PRIVATE-KEY-MARKER'}}});assert.equal(malformed.code,'image_generation_unknown');assert.equal(malformed.diagnostic,undefined);
  const beforeReads=calls;assert.deepEqual(await run({readReceipt:true,operationId:'direct'}),direct,'A Pi answer must be able to retrieve its image receipt without dispatch');
  assert.equal(await run({readReceipt:true,operationId:'never-generated'}),null);assert.equal(calls,beforeReads);
  assert.equal(await run({readReceipt:true,operationId:'disabled-never-generated',env:{IMAGE_ENABLED:'false',IMAGE_ASSETS:null}}),null,'An ordinary Ask without an image job must not report disabled images');
  assert.equal((await run({readReceipt:true,directCaller:{tenantId:'tenant-b',sourceOperationId:'direct'}})).code,'image_caller_denied');assert.equal(calls,beforeReads);
  assert.deepEqual(await run({readReceipt:true,operationId:'restart-intent'}),{status:'unknown',code:'image_generation_unknown'});assert.equal(calls,beforeReads,'A receipt read may not dispatch a claimed generation');
  const natural=await run({direct:true,operationId:'natural-image',explicitRequest:'홈페이지에 사용할 이미지를 만들어 줘'});assert.equal(natural.status,'ready','A current explicit image creation request may have a purpose prefix');
  for(const [operationId,explicitRequest] of [['natural-korean-draw','파란 나침반을 그려줘'],['natural-english-draw','draw a blue compass']])assert.equal((await run({direct:true,operationId,explicitRequest})).status,'ready','An explicit draw imperative need not say image');
  const beforeMentions=calls;
  for(const explicitRequest of ['이미지 관련 내용을 설명해 줘','직원이 "홈페이지에 사용할 이미지를 만들어 줘"라고 썼어. 내용을 설명해 줘.','이미지를 만들어 주지 말고 설명해 줘','이미지 만들지 말고 홈페이지에 사용할 이미지를 만들어 줘','이전 대화:\n이미지를 만들어줘'])assert.equal((await run({direct:true,operationId:'mention-'+beforeMentions,explicitRequest})).code,'image_explicit_request_required');
  assert.equal(calls,beforeMentions,'Mentioned or quoted image requests must not dispatch generation');
  const bucket=await mf.getR2Bucket('IMAGE_ASSETS');
  for(const state of ['ready','unknown']) {
    const legacy=await (await invoke({seedLegacy:rectangularPng.toString('base64'),seedStatus:state,operationId:'legacy-'+state})).json();const previous=await bucket.head(legacy.objectKey),beforeRecovery=calls;
    const restored=await run({readReceipt:true,operationId:'legacy-'+state});assert.equal(restored.status,'ready');assert.equal(restored.assetId,legacy.assetId);assert.equal(restored.width,1536);assert.equal(restored.height,1024);assert.equal(calls,beforeRecovery,'Legacy recovery must read stored bytes without regenerating');
    const current=await bucket.head(legacy.objectKey);assert.equal(current.etag,previous.etag);assert.equal(current.uploaded.getTime(),previous.uploaded.getTime());assert.equal(current.customMetadata.width,undefined,'Recovery must not overwrite an existing asset');
  }
  const invalidLegacy=Buffer.from(rectangularPng);invalidLegacy[0]=0;
  await invoke({seedLegacy:invalidLegacy.toString('base64'),seedStatus:'unknown',operationId:'legacy-invalid'});const beforeInvalidRecovery=calls;assert.equal((await run({operationId:'legacy-invalid'})).code,'image_response_invalid');assert.equal(calls,beforeInvalidRecovery);
  await invoke({seedLegacy:rectangularPng.toString('base64'),seedMissingObject:true,operationId:'legacy-missing'});assert.equal((await run({readReceipt:true,operationId:'legacy-missing'})).code,'image_response_invalid','A legacy ready row needs real bytes before it can report dimensions');assert.equal(calls,beforeInvalidRecovery);
  const stored=await bucket.list();assert.equal(stored.objects.length,14);
  const rectangularObject=await bucket.get(stored.objects.find(object=>object.key.endsWith('/'+rectangular.assetId)).key);assert.equal(rectangularObject.customMetadata.width,'1536');assert.equal(rectangularObject.customMetadata.height,'1024');
  const rows=await (await invoke({ledger:true})).json(); assert.doesNotMatch(JSON.stringify(rows),/Synthetic fixture|b64_json|synthetic-image-api-key|PRIVATE-KEY-MARKER/);
  console.log('Image registry, PNG/WebP bounds, provider isolation, paid-call dedupe, unknown recovery and native private R2 tenancy checks passed.');
} finally {await mf.dispose(); await rm(directory,{recursive:true,force:true});}
