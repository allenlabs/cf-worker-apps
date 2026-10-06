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
  if(data.r2Failure) env.IMAGE_ASSETS={head:key=>this.env.IMAGE_ASSETS.head(key),put:async()=>{throw Error('PRIVATE-KEY-MARKER')}};
  installImageTool({registry,env,ledger,resolveCaller:async(api,context)=>data.denied||context?.marker!=='native-context'?null:{tenantId:data.tenantId??'tenant-a',sourceOperationId:data.operationId??'source-a',explicitRequest:data.explicitRequest??'/image synthetic fixture'},generate:data.codexTransport?async({signal})=>{if(data.codexAuthFailure)throw Error('image_auth_needed');return fetch('https://codex-image.fixture.invalid/generate',{signal})}:undefined});
  const tool=registry.snapshot().tools().find(row=>row.tool.name==='generate_image')?.tool;
  if(data.inspect) return Response.json(tool?{name:tool.name,replay:tool.replay,executionMode:tool.executionMode,parameters:tool.parameters}:null);
  if(data.asset) return serveImageAsset(new Request('https://image.fixture.invalid/assets/'+data.asset),env,'session' in data?data.session:{tenantId:data.tenantId??'tenant-a'});
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
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(1024); ihdr.writeUInt32BE(1024,4); ihdr[8]=8;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(Buffer.alloc(1025*1024))),pngChunk('IEND',Buffer.alloc(0))]);
let mode = "normal", calls = 0, codexCalls = 0;
const outbound = async request => {
  calls++;
  if(request.url==='https://codex-image.fixture.invalid/generate') {
    codexCalls++;
    if(mode==='codex-auth') return new Response(null,{status:401});
    const image=Buffer.from(png); if(mode==='png-wrong-size')image.writeUInt32BE(512,16);
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
  return Response.json({ data: [{ b64_json: Buffer.from(webp).toString("base64") }], secret: "PRIVATE-KEY-MARKER" });
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
  return result.content?JSON.parse(result.content[0].text):result;
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
  for(const kind of ['codex-auth','png-wrong-size','png-magic']){mode=kind;const failed=await run({operationId:kind,codexTransport:true,env:codexEnv});assert.equal(failed.status,'failed');if(kind==='codex-auth')assert.equal(failed.code,'image_auth_needed');const before=calls;await run({operationId:kind,codexTransport:true,env:codexEnv});assert.equal(calls,before);}
  mode='normal'; const beforeInjectedApi=codexCalls; assert.equal((await run({operationId:'api-injection',codexTransport:true})).mediaType,'image/webp'); assert.equal(codexCalls,beforeInjectedApi,'API mode must ignore an injected Codex transport');
  const beforeAbort=calls; assert.equal((await run({operationId:'abort-after-claim',abortAfterClaim:true})).status,'unknown'); assert.equal(calls,beforeAbort,'Cancellation after durable claim must not dispatch generation');
  assert.equal((await run({operationId:'abort-after-claim'})).status,'unknown'); assert.equal(calls,beforeAbort,'A cancelled durable claim must never replay generation');
  const bucket=await mf.getR2Bucket('IMAGE_ASSETS'); const stored=await bucket.list(); assert.equal(stored.objects.length,5);
  const rows=await (await invoke({ledger:true})).json(); assert.doesNotMatch(JSON.stringify(rows),/Synthetic fixture|b64_json|synthetic-image-api-key|PRIVATE-KEY-MARKER/);
  console.log('Image registry, PNG/WebP bounds, provider isolation, paid-call dedupe, unknown recovery and native private R2 tenancy checks passed.');
} finally {await mf.dispose(); await rm(directory,{recursive:true,force:true});}
