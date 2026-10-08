import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";

process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(import.meta.url), wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const directory = await mkdtemp(join(tmpdir(), "cloud-agent-storage-check-")), entry = join(directory, "fixture.js"), bundle = join(directory, "worker.js");
await writeFile(entry, `
import worker, { Assistant as BaseAssistant, Credentials as BaseCredentials } from ${JSON.stringify(resolve("workers/pi/index.js"))};
import { DurableObject } from "cloudflare:workers";
import { Harness, createRegistry, defineDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openPiSessionStore } from "agents/harness/pi";
import { D1PiStorage, STORAGE_METHODS, MAX_COMMIT_BYTES } from ${JSON.stringify(resolve("workers/pi/pi-journal.js"))};
import { conversationDatabase, attachConversationStore, nativeSnapshot, storedHistory, objectKey, tenantId, pinTenant } from ${JSON.stringify(resolve("workers/pi/conversation-store.js"))};
const context={value:()=>undefined,toString:()=>"fixture",abortSignal:undefined};
const same=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error("legacy_public_read_mismatch");};
export class Probe extends DurableObject {
 async open(){await pinTenant(this.ctx,this.env);if(this.store)return this.store;const db=await conversationDatabase(this.env),store=new D1PiStorage(db,this.env.TENANT_ID,"probe:"+this.ctx.id);await store.statement("INSERT OR IGNORE INTO ca_streams(tenant_id,object_key,kind,created_at,updated_at,state) VALUES(?,?,'manual',0,0,'ready')").run();await store.replay();return this.store=store;}
 async fetch(request){try{const {method,args=[]}=await request.json(),store=await this.open();if(method==="isolation"){
  const other=new D1PiStorage(store.db,"other-tenant",store.objectKey);await other.statement("INSERT OR IGNORE INTO ca_streams(tenant_id,object_key,kind,created_at,updated_at,state) VALUES(?,?,'manual',0,0,'ready')").run();await other.replay();await other.commit([{type:"conversation",value:{id:1}},{type:"entry",value:{id:2,conversationId:1,kind:"pi.user",model:[{role:"user",content:"OTHER_TENANT_ONLY",timestamp:1}]}}]);
  const history=await storedHistory({...this.env,TENANT_ID:"other-tenant"},store.objectKey,1,{limit:50});let blocked=false;try{await pinTenant(this.ctx,{...this.env,TENANT_ID:"other-tenant"});}catch(error){blocked=error.message==="tenant_identity_immutable";}return Response.json({value:{history,blocked}});
 }if(method==="history")return Response.json({value:await storedHistory(this.env,store.objectKey,args[0],args[1])});if(method==="failure"){
  const real=store.db,loseRead=args[0];store.db={prepare:sql=>{if(loseRead&&sql.includes("SELECT checksum,payload"))throw Error("fixture_confirm_unavailable");return real.prepare(sql);},batch:async statements=>{await real.batch(statements);throw Error("fixture_lost_commit_response");}};
  let failed=false;try{await store.commit([{type:"entry",value:{id:await store.mintId(),conversationId:1,kind:"pi.user",model:[{role:"user",content:"FAILURE_PERSISTED",timestamp:1}]}}]);}catch{failed=true;}
  store.db=real;const reopened=new D1PiStorage(real,this.env.TENANT_ID,store.objectKey);await reopened.replay();return Response.json({failed,poisoned:!!store.poisoned,page:await reopened.scanEntries({conversationId:1},100,undefined,context),commits:reopened.commits});
 }if(!STORAGE_METHODS.includes(method))throw Error("fixture_method_invalid");const result=await store[method](...args);return Response.json({value:result});}catch(error){return Response.json({error:error.message,name:error.name},{status:400});}}
}
const Latest=defineDoc({kind:"fixture.latest",version:1,scope:"conversation",history:"latest",fork:"current",initial:()=>({count:0}),checkpointWhen:()=>true});
const Past=defineDoc({kind:"fixture.past",version:1,scope:"conversation",history:"rewindable",fork:"asOf",initial:()=>({count:0}),checkpointWhen:()=>true});
export class Legacy extends DurableObject {
 async fetch(request){const native=await openPiSessionStore(this.ctx.storage),models=createModels(),faux=fauxProvider({models:[{id:"fixture",name:"Fixture"}]});models.setProvider(faux.provider);const registry=createRegistry();const pi=await Harness.open(native,{models,registry},context),root=await pi.root(context,{agent:{model:{provider:faux.getModel().provider,id:"fixture"},thinkingLevel:"low"}});
  if(!this.ctx.storage.sql.exec("SELECT 1 FROM pi_entries LIMIT 1").toArray().length){
   await root.commit(async tx=>{(await tx.doc(Latest,1)).count=1;(await tx.doc(Past,1)).count=1;},context);
   faux.setResponses([fauxAssistantMessage("LEGACY_ANSWER")]);pi.resume();await(await root.submit({type:"input",content:"LEGACY_USER",requestId:"legacy-request"},context)).wait(context);
   const user=(await root.entries({},100,undefined,context)).items.find(entry=>entry.kind==="pi.user");
   await root.configure({thinkingLevel:"high"},context);await root.fork(user.id,{ownership:{kind:"ownerless"}},context);
   await root.commit(async tx=>{(await tx.doc(Latest,1)).count=2;(await tx.doc(Past,1)).count=2;},context);
   await root.commit(async tx=>{await tx.retireDoc(Latest,1);await tx.retireDoc(Past,1);},context);
   await root.commit(async tx=>{(await tx.doc(Latest,1)).count=3;(await tx.doc(Past,1)).count=3;},context);
   await root.commit(tx=>tx.appendEntry(1,{kind:"pi.reset",head:"self"}),context);
   await root.commit(tx=>tx.appendEntry(1,{kind:"pi.user",model:[{role:"user",content:"AFTER_RESET",timestamp:2}]}),context);
   await native.mintId();await native.mintId();await native.commit([],context);
  }
  await pi.close(context);
  const original=await openPiSessionStore(this.ctx.storage),snapshot=nativeSnapshot(this.ctx.storage.sql),sourceCount=snapshot.entries.length;
  const external=await attachConversationStore(original,this.ctx,this.env,{kind:"manual",accountId:"owner"},context);
  const comparison=await openPiSessionStore(this.ctx.storage);
  for(let seq=1;seq<snapshot.metadata[0].next_seq;seq++)for(const row of snapshot.documents){
   const record=JSON.parse(row.record);if(record.history==="rewindable")same(await comparison.document(row.id,seq,context),await external.document(row.id,seq,context));
  }
  for(const row of snapshot.conversations)for(let cutoff=1;cutoff<Number(snapshot.metadata[0].next_id);cutoff++){
   same(await comparison.scanEntries({conversationId:row.id,maxEntryId:cutoff},2,undefined,context),await external.scanEntries({conversationId:row.id,maxEntryId:cutoff},2,undefined,context));
   same(await comparison.findLatestHeadMarker(row.id,cutoff,context),await external.findLatestHeadMarker(row.id,cutoff,context));
  }
  const next=await original.mintId();if(next!==Number(snapshot.metadata[0].next_id))throw Error("legacy_id_floor_lost");
  await original.commit([{type:"entry",value:{id:next,conversationId:1,kind:"pi.user",model:[{role:"user",content:"EXTERNAL_ONLY",timestamp:3}]}}],context);
  const page=await storedHistory(this.env,objectKey("assistant",this.ctx.id.toString()),1,{limit:2});
  return Response.json({sourceCount,nativeCount:this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM pi_entries").toArray()[0].count,migration:await this.ctx.storage.get("conversationMigration"),page,externalCount:(await original.scanEntries({conversationId:1},100,undefined,context)).items.length,nextSeq:external.nextSeq});
 }
}
export class Resumable extends DurableObject {
 async fetch(request){
  const original=await openPiSessionStore(this.ctx.storage),sql=this.ctx.storage.sql;
  if(!sql.exec("SELECT 1 FROM pi_entries LIMIT 1").toArray().length){await original.commit([{type:"conversation",value:{id:1}}],context);for(let n=0;n<1050;n++){const id=await original.mintId();await original.commit([{type:"entry",value:{id,conversationId:1,kind:"pi.user",model:[{role:"user",content:"RESUMABLE_"+n,timestamp:n}]}}],context);}}
  const before=JSON.stringify(nativeSnapshot(sql)),oldCommit=original.commit;let statements=0;
  const countStatement=statement=>new Proxy(statement,{get(target,property){if(property==="bind")return(...args)=>countStatement(target.bind(...args));if(["first","all","run","raw"].includes(property))return(...args)=>{statements++;return target[property](...args);};return Reflect.get(target,property);}});
  const countDb=db=>({prepare:sql=>countStatement(db.prepare(sql)),batch:list=>{statements+=list.length;return db.batch(list);},withSession:constraint=>countDb(db.withSession(constraint))});
  try{const external=await attachConversationStore(original,this.ctx,{...this.env,CONVERSATIONS:countDb(this.env.CONVERSATIONS)},{kind:"manual"},context);return Response.json({ready:true,sourceUnchanged:before===JSON.stringify(nativeSnapshot(sql)),entries:(await external.scanEntries({conversationId:1},2000,undefined,context)).items.length,statements});}
  catch(error){if(error.message!=="conversation_migration_pending")throw error;return Response.json({ready:false,sourceUnchanged:before===JSON.stringify(nativeSnapshot(sql)),adapterUnchanged:oldCommit===original.commit,statements},{status:202});}
 }
}
export class WarmMigration extends BaseAssistant {
 constructor(ctx,env){super(ctx,env);this.seedReady=ctx.blockConcurrencyWhile(async()=>{const native=await openPiSessionStore(ctx.storage);if(!ctx.storage.sql.exec("SELECT 1 FROM pi_entries LIMIT 1").toArray().length){await native.commit([{type:"conversation",value:{id:1}}],context);for(let n=0;n<1050;n++){const id=await native.mintId();await native.commit([{type:"entry",value:{id,conversationId:1,kind:"pi.user",model:[{role:"user",content:"WARM_"+n,timestamp:n}]}}],context);}}});}
 async fetch(){await this.seedReady;this.fetchCount=(this.fetchCount||0)+1;try{await this.lifecycle.start();return Response.json({ready:true,fetchCount:this.fetchCount,calls:this.faux.state.callCount,nativeEntries:this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pi_entries").toArray()[0].n});}catch(error){if(error.message!=="conversation_migration_pending")throw error;return Response.json({ready:false,fetchCount:this.fetchCount,calls:this.faux.state.callCount},{status:202});}}
}
export class Assistant extends BaseAssistant {
 async fetch(request){const path=new URL(request.url).pathname;if(path==="/fixture/ask"){const input=await request.json();return Response.json(await this.manualAsk(input.prompt,input.operationId,"owner"));}if(path==="/fixture/state"){await this.lifecycle.start();return Response.json({entries:await this.history(),settings:{sessions:await this.harness.sessions.list()},nativeEntries:this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM pi_entries").toArray()[0].count,usage:await(await this.harness.pi()).usage(this.piContext),calls:this.faux.state.callCount});}if(path==="/fixture/fork"){const session=await this.harness.sessions.fork(this.runtime().sessionId);return Response.json({session:session.id,entries:await session.messages()});}return new Response("Not found",{status:404});}
}
export class Credentials extends BaseCredentials {async reportUsage(){return{accepted:true};}}
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname.startsWith("/probe/"))return env.Probe.getByName(url.pathname).fetch(request);if(url.pathname==="/legacy")return env.Legacy.getByName("legacy").fetch(request);if(url.pathname==="/resumable")return env.Resumable.getByName("resumable").fetch(request);if(url.pathname==="/warm-migration")return env.WarmMigration.getByName("warm-migration").fetch(request);return worker.fetch(request,env);}};
`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"], alias: { path: "node:path" }, target: "es2022", loader: { ".sql": "text" }, external: ["cloudflare:*", "node:*"], nodePaths: [resolve("node_modules"), resolve("../../node_modules")] });
const options = { name: "storage-check", modulesRoot: directory, modules: [{ type: "ESModule", path: bundle }], compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"], d1Databases: ["CONVERSATIONS"], durableObjects: { Probe: { className: "Probe", useSQLite: true }, Legacy: { className: "Legacy", useSQLite: true }, Resumable: { className: "Resumable", useSQLite: true }, WarmMigration: { className: "WarmMigration", useSQLite: true }, Assistant: { className: "Assistant", useSQLite: true }, Credentials: { className: "Credentials", useSQLite: true } }, resourcePersistencePath: join(directory, "storage"), bindings: { TENANT_ID: "fixture-tenant", TENANT_NAME: "Fixture tenant", PROBE_MODE: "mock", OPENAI_MODEL: "fixture", PUBLIC_ORIGIN: "https://fixture.invalid" }, outboundService: () => { throw Error("storage fixture attempted outbound network"); } };
let mf = new Miniflare(convertV4MiniflareOptions(options)), number = 0;
const invoke = async (path, method, args = []) => {
  const response = await mf.dispatchFetch("https://fixture.invalid" + path, { method: "POST", body: JSON.stringify({ method, args }) }), body = await response.json();
  if (!response.ok) { const error = Error(body.error); error.name = body.name || "Error"; throw error; } return method === "failure" ? body : body.value;
};
const assertions = { ok: assert.ok, strictEqual: assert.equal, deepEqual: assert.deepEqual, partialDeepEqual: assert.partialDeepStrictEqual, greaterThan: (a, b) => assert.ok(a > b), rejects: (operation, message) => assert.rejects(operation, error => error.message.includes(message)) };
try {
  const cases = createStorageConformance({ assertions, withStorage: async use => {
    const path = "/probe/conformance-" + number++, methods = ["commit", "mintId", "conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries", "task", "scanTasks", "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments", "close"], storage = Object.fromEntries(methods.map(method => [method, (...args) => invoke(path, method, args)]));
    await use(storage);
  } });
  for (const check of cases) { try { await check.run(); } catch (error) { throw Error("Storage conformance: " + check.name, { cause: error }); } }
  const path = "/probe/overlap";
  await invoke(path, "commit", [[{ type: "conversation", value: { id: 1 } }]]);
  const ids = await Promise.all([invoke(path, "mintId"), invoke(path, "mintId")]);
  const sequences = await Promise.all(ids.map(id => invoke(path, "commit", [[{ type: "entry", value: { id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "Overlap " + id, timestamp: 1 }] } }]])));
  assert.deepEqual(sequences, [2, 3]);
  const recovered = await invoke(path, "failure", [false]); assert.equal(recovered.failed, false); assert.equal(recovered.commits, 4);
  const poisoned = await invoke(path, "failure", [true]); assert.equal(poisoned.failed, true); assert.equal(poisoned.poisoned, true); assert.equal(poisoned.commits, 5);
  await assert.rejects(invoke(path, "mintId"), /reopen_required/);
  const legacy = await (await mf.dispatchFetch("https://fixture.invalid/legacy")).json(); assert.equal(legacy.sourceCount, legacy.nativeCount); assert.equal(legacy.migration.legacyBackup, true); assert.equal(legacy.page.storage.backend, "d1"); assert.equal(legacy.page.entries.at(-1).model[0].content, "EXTERNAL_ONLY"); assert.equal(legacy.page.pagination.hasMore, true);
  const isolation=await invoke(path,"isolation");assert.equal(isolation.blocked,true);assert.equal(isolation.history.entries.length,1);assert.equal(isolation.history.entries[0].model[0].content,"OTHER_TENANT_ONLY");assert.ok(!(await invoke(path,"history",[1,{limit:50}])).entries.some(entry=>entry.model[0].content==="OTHER_TENANT_ONLY"));
  const limitPath="/probe/limit";await invoke(limitPath,"commit",[[{type:"conversation",value:{id:1}}]]);
  await assert.rejects(invoke(limitPath,"commit",[[{type:"entry",value:{id:2,conversationId:1,kind:"pi.user",model:[{role:"user",content:"L".repeat(1048576),timestamp:1}]}}]]),/conversation_storage_limit/);assert.equal((await invoke(limitPath,"scanEntries",[{conversationId:1},10])).items.length,0);
  const deep = "/probe/deep-fork";
  await invoke(deep, "commit", [[{type:"conversation",value:{id:1}}]]);
  let parent=1,parentEntry=await invoke(deep,"mintId");
  await invoke(deep,"commit",[[{type:"entry",value:{id:parentEntry,conversationId:parent,kind:"pi.user",model:[{role:"user",content:"DEEP_ROOT",timestamp:1}]}}]]);
  for(let depth=0;depth<80;depth++){const id=await invoke(deep,"mintId"),entry=await invoke(deep,"mintId");await invoke(deep,"commit",[[{type:"conversation",value:{id,parent:{conversationId:parent,at:parentEntry}}},{type:"entry",value:{id:entry,conversationId:id,kind:"pi.user",model:[{role:"user",content:"DEPTH_"+depth,timestamp:1}]}}]]);parent=id;parentEntry=entry;}
  const deepNewest=await invoke(deep,"history",[parent,{limit:50}]),deepOlder=await invoke(deep,"history",[parent,{limit:50,before:deepNewest.pagination.nextBefore}]);
  assert.equal(deepNewest.entries.length,50);assert.equal(deepOlder.entries.length,31);assert.equal(deepOlder.entries[0].model[0].content,"DEEP_ROOT");assert.equal(deepOlder.pagination.hasMore,false);
  let migration,maxMigrationStatements=0,migrationAttempts=0;
  do {migration=await(await mf.dispatchFetch("https://fixture.invalid/resumable")).json();maxMigrationStatements=Math.max(maxMigrationStatements,migration.statements);migrationAttempts++;assert.equal(migration.sourceUnchanged,true);if(!migration.ready)assert.equal(migration.adapterUnchanged,true);if(migrationAttempts===5){await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(options));}assert.ok(migrationAttempts<100);}while(!migration.ready);
  assert.equal(migration.entries,1050);assert.ok(migrationAttempts>10);assert.ok(maxMigrationStatements<1000);
  let warm,warmAttempts=0;do{warm=await(await mf.dispatchFetch("https://fixture.invalid/warm-migration")).json();warmAttempts++;assert.equal(warm.calls,0);assert.equal(warm.fetchCount,warmAttempts);assert.ok(warmAttempts<100);}while(!warm.ready);assert.equal(warm.nativeEntries,1050);
  const ns = await mf.getDurableObjectNamespace("Assistant"), assistant = ns.get(ns.idFromName("native-session"));
  const askInput = { prompt: "NEW_D1_CONTEXT", operationId: "manual-storage-fixture" }, ask = () => assistant.fetch("https://fixture.invalid/fixture/ask", { method: "POST", body: JSON.stringify(askInput) });
  assert.equal((await ask()).status, 200); const state = await (await assistant.fetch("https://fixture.invalid/fixture/state")).json(); assert.equal(state.nativeEntries, 0); assert.equal(state.calls, 1);
  const database=await mf.getD1Database("CONVERSATIONS"),journalSize=await database.prepare("SELECT COUNT(*) AS commits,SUM(bytes) AS bytes FROM ca_commits WHERE tenant_id=? AND object_key=?").bind("fixture-tenant","assistant:"+ns.idFromName("native-session").toString()).first();
  assert.equal((await ask()).status, 200); assert.equal((await (await assistant.fetch("https://fixture.invalid/fixture/state")).json()).calls, 1);
  const fork = await (await assistant.fetch("https://fixture.invalid/fixture/fork")).json(); assert.ok(JSON.stringify(fork.entries).includes("NEW_D1_CONTEXT"));
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const restartNs = await mf.getDurableObjectNamespace("Assistant"), restarted = restartNs.get(restartNs.idFromName("native-session"));
  const after = await (await restarted.fetch("https://fixture.invalid/fixture/state")).json(); assert.equal(after.nativeEntries, 0); assert.deepEqual(after.entries, state.entries); assert.deepEqual(after.usage, state.usage); assert.equal(after.settings.sessions.length, 2);
  assert.equal((await restarted.fetch("https://fixture.invalid/fixture/ask", { method: "POST", body: JSON.stringify(askInput) })).status, 200); assert.equal((await (await restarted.fetch("https://fixture.invalid/fixture/state")).json()).calls, 0);
  console.log(JSON.stringify({ checks: "PASS", storageConformanceCases: cases.length, runtime: "workerd", d1: true, concurrentCommits: true, ambiguousCommitResolution: true, poisonedCommitReopens: true, nativeTranscriptRows: 0, nativePiRestartForkReplayUsage: true, legacyAllSequenceDocumentsAndForkCutoffs: true, legacyBackupPreserved: true, pagedArchive: true, deepForkDepth: 80, tenantIsolationAndImmutablePin: true, oversizedCommitRejectedBeforeEffect: true, nativeOneMockReply: journalSize, resumableLegacyEntries: 1050, migrationAttempts, warmLifecycleMigrationAttempts: warmAttempts, maxMigrationStatements, realNetworkCalls: 0 }));
} finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
