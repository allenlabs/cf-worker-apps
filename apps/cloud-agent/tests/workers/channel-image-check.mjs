import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const directory=await mkdtemp(join(tmpdir(),"channel-image-check-")),entry=join(directory,"fixture.js"),bundle=join(directory,"worker.js");
const helper=fileURLToPath(new URL("../../workers/pi/channel-image.js",import.meta.url));
await writeFile(entry,`import { DurableObject } from 'cloudflare:workers';
import { deliverChannelImage,readImageTransfer } from ${JSON.stringify(helper)};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
export class Fixture extends DurableObject {
 async fetch(request) {
  const path=new URL(request.url).pathname;
  if(path.startsWith('/image-transfer/'))return readImageTransfer({env:this.env,ledger:this.ctx.storage,token:path.split('/')[3],method:request.method});
  const data=await request.json(),env={...this.env,...data.env},operation=data.operationId??'source-a';
  if(data.inspect)return Response.json([...await this.ctx.storage.list()]);
  if(data.revokeDuringRead){const key='image-transfer:'+await hash(data.revokeDuringRead),bucket=env.IMAGE_ASSETS;return readImageTransfer({env:{...env,IMAGE_ASSETS:{get:async(...args)=>{const object=await bucket.get(...args);await this.ctx.storage.delete(key);return object;}}},ledger:this.ctx.storage,token:data.revokeDuringRead,method:'GET'});}
  if(data.expire){for(const [key,row] of await this.ctx.storage.list({prefix:'image-transfer:'}))await this.ctx.storage.put(key,{...row,expiresAt:0});return Response.json({expired:true});}
  if(data.seed){const assetId=crypto.randomUUID(),bytes=Uint8Array.from(atob(data.seed),char=>char.charCodeAt(0)),image={status:'ready',assetId,mediaType:'image/png',bytes:bytes.length,width:32,height:32,url:'https://cloud.fixture.invalid/assets/'+assetId};
   await env.IMAGE_ASSETS.put('images/'+await hash(env.TENANT_ID)+'/'+assetId,bytes,{httpMetadata:{contentType:image.mediaType},customMetadata:{tenantId:env.TENANT_ID,assetId,width:'32',height:'32'}});
   await this.ctx.storage.put('image-job:'+await hash(JSON.stringify([env.TENANT_ID,operation])),{status:image.status,assetId:image.assetId,mediaType:image.mediaType,bytes:image.bytes,width:image.width,height:image.height,tenantId:env.TENANT_ID});return Response.json(image);}
  return Response.json(await deliverChannelImage({env,ledger:this.ctx.storage,actorId:data.actorId??this.ctx.id.toString(),target:data.target??{channelId:'channel-a',groupId:'test-a',rootMessageId:'root-a'},sourceOperationId:operation,image:data.image,access:Object.hasOwn(data,'access')?data.access:'synthetic-channel-token'}));
 }
}
export default{fetch(request,env){try{const actor=new URL(request.url).pathname.match(/^\\/image-transfer\\/([a-f0-9]{64})\\//)?.[1];return (actor?env.JOBS.get(env.JOBS.idFromString(actor)):env.JOBS.getByName('fixture')).fetch(request)}catch{return new Response(null,{status:404})}}};`);
await build({entryPoints:[entry],outfile:bundle,bundle:true,format:"esm",platform:"browser",target:"es2022",external:["cloudflare:workers"],logLevel:"silent"});
const chunk=(name,data)=>{const value=Buffer.alloc(data.length+12);value.writeUInt32BE(data.length);value.write(name,4);data.copy(value,8);return value;};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32);ihdr.writeUInt32BE(32,4);ihdr[8]=8;
const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(33*32))),chunk('IEND',Buffer.alloc(0))]);
const captures=new Map();let mode='success',calls=0,mf;
const outbound=async request=>{
 calls++;assert.equal(request.url,'https://app-store-api.channel.io/general/v1/native/functions');assert.equal(request.headers.get('x-access-token'),'synthetic-channel-token');
 const body=await request.json();assert.equal(body.method,'writeGroupMessage');assert.equal(body.params.channelId,'channel-a');assert.equal(body.params.groupId,'test-a');assert.equal(body.params.rootMessageId,'root-a');assert.equal(body.params.broadcast,false);
 const source=body.params.dto.requestId.slice(4),file=body.params.dto.files[0];assert.equal(body.params.dto.files.length,1);assert.equal(file.mime,'image/png');assert.match(file.fileName,/^image-[a-f0-9-]+\.png$/);assert.match(file.url,/^https:\/\/cloud\.fixture\.invalid\/image-transfer\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
 captures.set(source,file.url);if(mode!=='ack-without-fetch'){const transferred=await mf.dispatchFetch(file.url);assert.equal(transferred.status,200);assert.equal(transferred.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await transferred.arrayBuffer()),bytes);}
 if(mode==='network')throw Error('PRIVATE-KEY-MARKER');
 if(mode==='rejected')return Response.json({error:{message:'PRIVATE-KEY-MARKER'}},{status:400});
 if(mode==='envelope-error')return Response.json({error:{message:'PRIVATE-KEY-MARKER'}});
 if(mode==='server-error'||mode==='timeout')return Response.json({error:{message:'PRIVATE-KEY-MARKER'}},{status:mode==='timeout'?408:503});
 const message={id:'message-'+source};if(['success','ack-without-fetch','wrong-mime','wrong-size'].includes(mode))message.files=[{key:'fixture/image.png',bucket:'channel-fixture',mime:mode==='wrong-mime'?'image/webp':'image/png',size:mode==='wrong-size'?bytes.length+1:bytes.length}];if(mode==='echo')message.files=[{url:file.url,mime:'image/png'}];if(mode==='bad-file')message.files=[null];
 return Response.json({result:{message},secret:'PRIVATE-KEY-MARKER'});
};
mf=new Miniflare(convertV4MiniflareOptions({name:'channel-image-check',modulesRoot:directory,modules:[{type:'ESModule',path:bundle}],compatibilityDate:'2026-10-04',compatibilityFlags:['nodejs_compat'],bindings:{TENANT_ID:'tenant-a',PUBLIC_ORIGIN:'https://cloud.fixture.invalid',ALLOWED_CHANNEL_ID:'channel-a',VISIT_MCP_GROUP_ID:'test-a',IMAGE_CHANNEL_DELIVERY_ENABLED:'true'},durableObjects:{JOBS:{className:'Fixture',useSQLite:true}},r2Buckets:{IMAGE_ASSETS:'images'},outboundService:outbound}));
const invoke=data=>mf.dispatchFetch('https://cloud.fixture.invalid/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
const run=async data=>{const result=await(await invoke(data)).json();assert.doesNotMatch(JSON.stringify(result),/PRIVATE-KEY-MARKER|synthetic-channel-token|\/image-transfer\//);return result;};
const seed=async operationId=>await(await invoke({seed:bytes.toString('base64'),operationId})).json();
try {
 assert.equal((await run({env:{IMAGE_CHANNEL_DELIVERY_ENABLED:'false'}})).status,'disabled');assert.equal(calls,0);
 const authImage=await seed('missing-auth');assert.equal((await run({image:authImage,operationId:'missing-auth',access:''})).status,'failed','Missing known auth must fail before creating a send intent');assert.equal(calls,0);assert.equal((await(await invoke({inspect:true})).json()).filter(([key])=>key.startsWith('image-transfer:')).length,0);
 const image=await seed('source-a');const sent=await run({image});assert.equal(sent.status,'sent');assert.equal(sent.replyId,'message-source-a');assert.equal(sent.fileCount,1);assert.equal(calls,1);
 const url=captures.get('source-a');assert.equal((await mf.dispatchFetch(url)).status,404,'A copied attachment must revoke its transfer capability');
 assert.deepEqual(await run({image}),sent);assert.equal(calls,1,'Confirmed attachment must never post twice');
 assert.equal((await run({image,actorId:'b'.repeat(64)})).status,'failed');assert.equal(calls,1);
 assert.equal((await run({image,target:{channelId:'channel-a',groupId:'test-a',rootMessageId:'other-root'}})).status,'failed');assert.equal(calls,1);
 assert.equal((await run({image,env:{TENANT_ID:'tenant-b'}})).status,'failed');assert.equal(calls,1);
 assert.equal((await run({image:{...image,assetId:crypto.randomUUID()},operationId:'source-a'})).status,'failed');assert.equal(calls,1);
 for(const kind of ['network','rejected','envelope-error','server-error','timeout','missing','echo','wrong-mime','wrong-size','bad-file','ack-without-fetch']){mode=kind;const operationId='source-'+kind,asset=await seed(operationId),result=await run({image:asset,operationId});assert.equal(result.status,['rejected','envelope-error'].includes(kind)?'failed':'unknown',kind);const before=calls;mode='success';assert.deepEqual(await run({image:asset,operationId}),result);assert.equal(calls,before,'Ambiguous/failed native send must not replay');if(['rejected','envelope-error'].includes(kind))assert.equal((await mf.dispatchFetch(captures.get(operationId))).status,404,'A clear native rejection revokes its transfer');if(!['network','rejected','envelope-error','server-error','timeout'].includes(kind))assert.equal(result.replyId,'message-'+operationId,'Ambiguity preserves a verified native acknowledgement');}
 const pendingUrl=captures.get('source-missing');assert.equal((await mf.dispatchFetch(pendingUrl,{method:'HEAD'})).status,200);assert.equal((await mf.dispatchFetch(pendingUrl,{method:'POST'})).status,404);
 const unfetchedUrl=captures.get('source-ack-without-fetch'),unfetchedToken=unfetchedUrl.split('/').at(-1),capabilityKey='image-transfer:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(unfetchedToken))).toString('hex');assert.equal((await mf.dispatchFetch(unfetchedUrl,{method:'HEAD'})).status,200);assert.equal((await(await invoke({inspect:true})).json()).find(([key])=>key===capabilityKey)[1].fetchedAt,undefined,'HEAD must not count as a completed image transfer');assert.equal((await invoke({revokeDuringRead:unfetchedToken})).status,404,'A GET racing with revocation must not resurrect the capability');assert.ok(!(await(await invoke({inspect:true})).json()).some(([key])=>key===capabilityKey));
 const wrongActor=pendingUrl.replace(/\/image-transfer\/[a-f0-9]{64}\//,'/image-transfer/'+'b'.repeat(64)+'/');assert.equal((await mf.dispatchFetch(wrongActor)).status,404);
 await invoke({expire:true});assert.equal((await mf.dispatchFetch(pendingUrl)).status,404);
 const rows=await(await invoke({inspect:true})).json();for(const transfer of captures.values())assert.ok(!JSON.stringify(rows).includes(transfer.split('/').at(-1)),'Only token hashes may persist');assert.doesNotMatch(JSON.stringify(rows),/PRIVATE-KEY-MARKER|synthetic-channel-token|https:\/\//);
 console.log('Native image files, pinned delivery, private R2 transfer bytes, revocation, expiry and no-replay checks passed.');
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
