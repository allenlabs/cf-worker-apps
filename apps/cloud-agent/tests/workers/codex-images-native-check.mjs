import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { piTextModules } from "./pi-modules.mjs";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const email = "native-subscription@example.invalid", admin = "native-admin@example.invalid", clientId = "fixture-codex-client";
const session = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
await writeFile("build/pi/codex-images-wrapper.js", `import worker,{Assistant as BaseAssistant,Credentials as BaseCredentials,GitHubAuthoring as BaseGitHubAuthoring,CloudAgentInference} from './index.js';
import {codexImageRequest} from './codex-auth-fixture.js';
export {CloudAgentInference};
export default {async fetch(request,env){if(new URL(request.url).pathname==='/fixture-bridge'){try{const call=await env.FixtureBridge.infer({version:1,requestId:crypto.randomUUID(),userId:'fixture@example.invalid',context:{messages:[{role:'user',content:'Bridge fixture',timestamp:1}]},options:{}});const text=await new Response(call.stream).text();call.cancellation[Symbol.dispose]();return Response.json({events:text.split('\\n').filter(Boolean).map(value=>JSON.parse(value).event)});}catch(error){return Response.json({error:error.message},{status:400});}}return worker.fetch(request,env);}};
export class Assistant extends BaseAssistant {
 async fetch(request){try{const input=await request.json();if(input.forget){await this.ctx.storage.delete('manualOperation:'+input.forget);return Response.json({ok:true});}if(input.admission)return Response.json(await this.ctx.storage.get('manualOperation:'+input.admission));if(input.snapshot)return Response.json(await this.operationSnapshot());if(input.settings)return Response.json(await this.adminSettings());if(input.change){const snapshot=await this.operationSnapshot();await this.changeSettings('model',input.change,snapshot);return Response.json(await this.operationSnapshot());}if(input.manual)return Response.json(await this.manualAsk(input.prompt,input.operationId,'owner'));return Response.json(await this.ask(input.prompt,input.operationId,input.pinned));}catch(error){return Response.json({error:error.message},{status:400});}}
}
export class GitHubAuthoring extends BaseGitHubAuthoring {
 async fetch(request){try{const input=await request.json();if(input.initialize)return Response.json(await this.initialize({actor:'fixture-admin',sourceId:'fixture-source',generation:1,repository:'fixture-org/fixture-repo',branch:'main',prefix:'docs/',accountId:'owner'},'a'.repeat(40)));if(input.pin){this.draftSql.exec('INSERT INTO github_asks(id,request,prompt,model) VALUES(?,?,?,?)',input.pin.id,input.pin.request,'',JSON.stringify(input.pin.model));return Response.json({ok:true});}if(input.admissions)return Response.json(this.draftSql.exec('SELECT id,model FROM github_asks ORDER BY id').toArray());return Response.json(await this.ask(input));}catch(error){return Response.json({error:error.message},{status:400});}}
}
export class Credentials extends BaseCredentials {
 async githubAuthorize(){return {fixture:true};}
 async codexAccess(force=false){this.fixtureCodexAccessCalls=(this.fixtureCodexAccessCalls??0)+1;return super.codexAccess(force);}

 async fetch(request){try{const path=new URL(request.url).pathname;
  if(path==='/codex-access-calls')return Response.json({count:this.fixtureCodexAccessCalls??0});
  if(path==='/status')return Response.json(await this.status());
  if(path==='/refresh-status')return Response.json(await this.refreshStatus());
  if(path==='/legacy-access')return Response.json({access:await this.access()});
  if(path==='/status-guard'){const previous=this.ctx;this.ctx={id:previous.id,storage:{get(){throw Error('fixture_credential_read_before_validation');}}};try{return Response.json(await this.status());}finally{this.ctx=previous;}}
  if(path==='/refresh-guard'){const previous=this.ctx;this.ctx={id:previous.id,storage:{get(){throw Error('fixture_credential_read_before_validation');}}};try{return Response.json(await this.refreshStatus());}finally{this.ctx=previous;}}
  if(path==='/copy'){await this.ctx.storage.put(await request.json());return Response.json({ok:true});}
  if(path==='/export')return Response.json(Object.fromEntries(await this.ctx.storage.list()));
  if(path==='/legacy'){const input=await request.json();if(input.missing)await this.ctx.storage.delete('credential');else{const old=await this.open(await this.ctx.storage.get('credential'));await this.ctx.storage.put('credential',await this.seal({...old,scopes:input.scopes,expiresAt:input.expiresAt??old?.expiresAt}));}return Response.json({ok:true});}
  if(path==='/seed'){await this.ctx.storage.put({['adminSession:${hash(session)}']:{expiresAt:Date.now()+3600000,sealed:await this.seal({principal:{email:'${admin}',role:'super_admin',issuer:'https://sso.example.invalid',subject:'fixture-admin'},csrf:'${csrf}'})},identity:await this.seal({source:'verified_id_token',email:'${email}',accountId:'fixture-account',planType:'enterprise',verifiedAt:'2026-10-01T00:00:00Z'}),registration:{clientId:'fixture-siwc-client',subjectHash:'${hash("legacy-subject")}',accountHash:'${hash("fixture-account")}',planUsageConfirmed:true},credential:await this.seal({clientId:'fixture-siwc-client',access:'fixture-siwc-access',refresh:'fixture-siwc-refresh',expiresAt:Date.now()+3600000,scopes:['resource.invoke','chatgpt.tokens.use.direct']})});return Response.json({ok:true});}
  if(path==='/ready'){const pending=await this.open(await this.ctx.storage.get('codexImagePending'));await this.ctx.storage.put('codexImagePending',await this.seal({...pending,nextAt:0}));return Response.json({ok:true});}
  if(path==='/expire'){const profile=await this.open(await this.ctx.storage.get('codexImageProfile'));await this.ctx.storage.put('codexImageProfile',await this.seal({...profile,expiresAt:0}));return Response.json({ok:true});}
  if(path==='/inspect')return Response.json({profile:await this.ctx.storage.get('codexImageProfile'),pending:await this.ctx.storage.get('codexImagePending'),credential:await this.ctx.storage.get('credential'),registration:await this.ctx.storage.get('codexRegistration')});
  if(path==='/unpin-legacy-workspace'){await this.ctx.storage.put('registration',{clientId:'fixture-siwc-client',subjectHash:'${hash("legacy-subject")}',planUsageConfirmed:true});return Response.json({ok:true});}
  if(path==='/pin-other'){await this.ctx.storage.put('registration',{clientId:'fixture-siwc-client',subjectHash:'${hash("legacy-subject")}',accountHash:'${hash("other-account")}'});return Response.json({ok:true});}
  if(path==='/force-access')return Response.json(await this.codexAccess(true));
  if(path==='/access')return Response.json(await this.codexAccess());
  if(path==='/image-access')return Response.json(await this.codexImageAccess());
  if(path==='/image'){const profile=await this.codexImageAccess();return codexImageRequest(this.env,profile,'Fixture image');}
  return Response.json({error:'fixture_route_missing'},{status:404});
 }catch(error){return Response.json({error:error.message},{status:400});}}
}`);
await copyFile("workers/pi/codex-images-auth.js", "build/pi/codex-auth-fixture.js");
await copyFile("workers/pi/codex-http.js", "build/pi/codex-http.js");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-subscription-key", alg: "RS256", use: "sig" };
let issuedAccess, refreshFailure=false, providerFailure=false, legacyRefreshCalls=0, legacyRefreshIdentity=false;
let overrides = {}, accessAccount = "fixture-account", pendingStatus = 200, exchangeCalls = 0, refreshCalls = 0, jwksCalls = 0;
const accessToken = () => `e30.${Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:accessAccount}})).toString("base64url")}.fixture-signature`;
const jwt = (legacy=false) => {
 const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
 const body = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: legacy?"fixture-siwc-client":clientId, sub: legacy?"legacy-subject":"codex-subject-distinct-from-siwc", email, email_verified: true, exp: Date.now()/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:"fixture-account",chatgpt_plan_type:legacy?"business":"plus"},...overrides})).toString("base64url");
 return `${header}.${body}.${sign("RSA-SHA256",Buffer.from(`${header}.${body}`),privateKey).toString("base64url")}`;
};
const verifier="fixture-code-verifier-abcdefghijklmnopqrstuvwxyz",challenge=createHash("sha256").update(verifier).digest("base64url"),backend=[];
const persist=await mkdtemp(join(tmpdir(),"codex-unified-native-"));
const sse = () => {
 const message={id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"NATIVE_SUBSCRIPTION_OK",annotations:[]}]};
 const events=[{type:"response.created",response:{id:"resp_fixture",status:"in_progress"}},{type:"response.output_item.added",output_index:0,item:{...message,status:"in_progress",content:[]}},{type:"response.content_part.added",item_id:message.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",item_id:message.id,output_index:0,content_index:0,delta:"NATIVE_SUBSCRIPTION_OK"},{type:"response.output_item.done",output_index:0,item:message},{type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[message],usage:{input_tokens:3,output_tokens:2,total_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
 return new Response(events.map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
};
const config={name:"cloud-agent",modulesRoot:resolve("build/pi"),modules:["codex-images-wrapper.js","index.js","codex-auth-fixture.js","codex-http.js"].map(name=>({type:"ESModule",path:resolve("build/pi",name)})).concat(await piTextModules(resolve("build/pi"))),compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],serviceBindings:{FixtureBridge:{name:"cloud-agent",entrypoint:"CloudAgentInference"}},durableObjects:{Credentials:{className:"Credentials",useSQLite:true},Assistant:{className:"Assistant",useSQLite:true},GitHubAuthoring:{className:"GitHubAuthoring",useSQLite:true}},d1Databases:["CONVERSATIONS"],resourcePersistencePath:persist,bindings:{PUBLIC_ORIGIN:"https://agent.example.invalid",OWNER_EMAIL_SHA256:hash(email),TOKEN_WRAPPING_KEY:randomBytes(32).toString("base64url"),CODEX_IMAGE_CLIENT_ID:clientId,SUPER_ADMIN_EMAILS:JSON.stringify([admin]),SSO_ISSUER:"https://sso.example.invalid",TENANT_ID:"fixture-tenant",PROBE_MODE:"subscription",OPENAI_MODEL:"gpt-6.1-sol",PROBE_DEADLINE_MS:"30000",IMAGE_PROVIDER:"codex",INFERENCE_BRIDGE_ACCOUNT_ID:"owner",INFERENCE_BRIDGE_MODEL:"gpt-6.1-sol",INFERENCE_BRIDGE_ALLOWED_USER_IDS:'["fixture@example.invalid"]'},outboundService:async request=>{
 if(request.url.endsWith("/.well-known/jwks.json")){jwksCalls++;return Response.json({keys:[jwk]});}
 if(request.url.endsWith("/deviceauth/usercode")){assert.deepEqual(await request.json(),{client_id:clientId});return Response.json({device_auth_id:"fixture-device",user_code:"FIXTURE-CODE",interval:"1"});}
 if(request.url.endsWith("/deviceauth/token")){assert.deepEqual(await request.json(),{device_auth_id:"fixture-device",user_code:"FIXTURE-CODE"});return pendingStatus===200?Response.json({authorization_code:"fixture-code",code_verifier:verifier,code_challenge:challenge}):new Response(null,{status:pendingStatus});}
 if(request.url==="https://auth.openai.com/api/accounts/oauth/token"){
  const body=new URLSearchParams(await request.text());assert.equal(body.get("client_id"),"fixture-siwc-client");assert.equal(body.get("resource"),"https://api.openai.com/v1");assert.equal(body.get("grant_type"),"refresh_token");assert.equal(body.get("refresh_token"),"fixture-siwc-refresh");legacyRefreshCalls++;
  return Response.json({access_token:"fixture-siwc-access",refresh_token:"fixture-siwc-refresh",expires_in:3600,token_type:"Bearer",scope:"resource.invoke chatgpt.tokens.use.direct",...(legacyRefreshIdentity?{id_token:jwt(true)}:{})});
 }
 if(request.url==="https://auth.openai.com/oauth/token"){
  const raw=await request.text(),form=new URLSearchParams(raw),body=request.headers.get("content-type").includes("application/json")?JSON.parse(raw):Object.fromEntries(form);
  assert.equal(body.client_id,clientId);assert.equal(body.resource,undefined);
  if(body.grant_type==="refresh_token"){refreshCalls++;assert.equal(body.refresh_token,"fixture-codex-refresh");await new Promise(resolve=>setTimeout(resolve,30));}else exchangeCalls++;
  if(refreshFailure)return Response.json({error:"fixture unavailable"},{status:503});
  return Response.json({access_token:(issuedAccess=accessToken()),refresh_token:"fixture-codex-refresh",id_token:jwt(),expires_in:3600,token_type:"Bearer"});
 }
 const body=request.headers.get("content-encoding")==="zstd"?JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString()):await request.json();backend.push({url:request.url,body,authorization:request.headers.get("authorization"),account:request.headers.get("chatgpt-account-id"),accept:request.headers.get("accept")});
 if(request.url==="https://api.openai.com/v1/responses"){assert.equal(request.headers.get("authorization"),"Bearer fixture-siwc-access");return providerFailure?Response.json({error:{message:"fixture SIWC denied",type:"permission_denied"}},{status:403}):sse();}
 if(request.url==="https://chatgpt.com/backend-api/codex/images/generations"){assert.equal(request.headers.get("authorization"),`Bearer ${issuedAccess}`);assert.equal(request.headers.get("chatgpt-account-id"),"fixture-account");assert.equal(body.model,"gpt-image-2");return Response.json({data:[{b64_json:"Zml4dHVyZQ==",generation_id:"fixture-image"}]});}
 assert.equal(request.url,"https://chatgpt.com/backend-api/codex/responses");assert.equal(request.headers.get("authorization"),`Bearer ${issuedAccess}`);assert.equal(request.headers.get("chatgpt-account-id"),"fixture-account");assert.equal(request.headers.get("accept"),"text/event-stream");assert.equal(body.model,"gpt-6.1-sol");return providerFailure?Response.json({error:{message:"fixture Codex denied",type:"permission_denied"}},{status:403}):sse();
}};
let mf=new Miniflare(convertV4MiniflareOptions(config));
const peer="account-12345678-1234-1234-1234-123456789abc";
const direct=async(path,body,name="owner")=>{const ns=await mf.getDurableObjectNamespace("Credentials");return ns.get(ns.idFromName(name)).fetch("https://fixture.invalid"+path,body===undefined?{}:{method:"POST",body:JSON.stringify(body)});};
const configure=async policy=>mf.setOptions(convertV4MiniflareOptions({...config,bindings:{...config.bindings,...policy}}));
const bridge=()=>mf.dispatchFetch("https://fixture.invalid/fixture-bridge");
const ask=async body=>{const ns=await mf.getDurableObjectNamespace("Assistant");return ns.get(ns.idFromName("fixture-thread")).fetch("https://fixture.invalid/ask",{method:"POST",body:JSON.stringify(body)});};
const github=async body=>{const ns=await mf.getDurableObjectNamespace("GitHubAuthoring");return ns.getByName("fixture-github").fetch("https://fixture.invalid",{method:"POST",body:JSON.stringify(body)});};
const post=(path,body,authenticated=true,csrfValue=csrf)=>mf.dispatchFetch("https://agent.example.invalid"+path,{method:"POST",headers:{"content-type":"application/json",origin:"https://agent.example.invalid",...(authenticated?{cookie:`__Host-cloud_agent_session=${session}`,"x-csrf-token":csrfValue}:{})},body:JSON.stringify(body)});
const start=()=>post("/api/accounts/start",{id:"owner",planUsageConfirmed:true});
const complete=async()=>{await direct("/ready");return post("/api/accounts/check",{id:"owner"});};
try{
 assert.equal((await start()).status,401);await direct("/seed");
 assert.equal((await post("/api/accounts/start",{id:"owner",planUsageConfirmed:true},true,"wrong")).status,403);
 assert.equal((await post("/api/accounts/start",{id:"owner"})).status,400);
 const oldSnapshot=await (await ask({snapshot:true})).json();assert.equal(oldSnapshot.model.provider,"openai");
 const old=await ask({manual:true,prompt:"Before login",operationId:"fixture-before"});assert.equal(old.status,200,await old.clone().text());const oldResult=await old.json();assert.equal(oldResult.text,"NATIVE_SUBSCRIPTION_OK",JSON.stringify(oldResult));
 assert.equal((await start()).status,200);pendingStatus=403;assert.equal((await (await complete()).json()).pending,true);
 const pendingAsk=await ask({prompt:"During pending login",operationId:"fixture-pending"});assert.equal(pendingAsk.status,200,await pendingAsk.clone().text());
 pendingStatus=200;overrides={aud:"wrong-client"};const failed=await complete();assert.equal(failed.status,400);assert.equal((await failed.json()).error,"id_token_audience_mismatch");
 const failedAsk=await ask({prompt:"After failed login",operationId:"fixture-failed"});assert.equal(failedAsk.status,200,await failedAsk.clone().text());
 overrides={};assert.equal((await start()).status,200);const connected=await complete();assert.equal(connected.status,200,await connected.clone().text());assert.equal((await connected.json()).inferenceReady,true);
 const sealed=await (await direct("/inspect")).json();assert(sealed.profile.ciphertext);assert(sealed.credential.ciphertext);assert(!JSON.stringify(sealed).includes("fixture-codex-refresh"));
 await ask({forget:"fixture-before"});
 const callsBeforeReplay=backend.length;const manualReplay=await ask({manual:true,prompt:"Before login",operationId:"fixture-before"});assert.equal(manualReplay.status,200,await manualReplay.clone().text());assert.equal((await manualReplay.json()).text,"NATIVE_SUBSCRIPTION_OK");assert.equal(backend.length,callsBeforeReplay,"manual replay retains admission and does not dispatch another provider");const migratedAdmission=await (await ask({admission:"fixture-before"})).json();assert.equal(migratedAdmission.snapshot.model.provider,"openai","native legacy submission retains SIWC when outer admission row did not exist before migration");
 const snapshot=await (await ask({snapshot:true})).json();assert.equal(snapshot.model.provider,"openai-codex");assert.equal(snapshot.model.id,oldSnapshot.model.id);
 const inference=await ask({manual:true,prompt:"After unified login",operationId:"fixture-unified"});assert.equal(inference.status,200,await inference.clone().text());const inferenceResult=await inference.json();assert.equal(inferenceResult.text,"NATIVE_SUBSCRIPTION_OK",JSON.stringify(inferenceResult));
 assert(backend.at(-1).body.input.some(message=>JSON.stringify(message).includes("Before login")),"existing thread context survives provider migration");
 const image=await direct("/image");assert.equal(image.status,200,await image.clone().text());assert.equal((await image.json()).data[0].generation_id,"fixture-image");
 const imageProfile=await (await direct("/image-access")).json();const inferenceProfile=await (await direct("/access")).json();assert.equal(imageProfile.access,inferenceProfile.access);assert.equal(imageProfile.accountId,"fixture-account");
 const pinned=await ask({prompt:"Already admitted legacy operation",operationId:"fixture-pinned",pinned:oldSnapshot});assert.equal(pinned.status,200,await pinned.clone().text());assert.equal(backend.at(-1).url,"https://api.openai.com/v1/responses");
 await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(config));
 const restarted=await mf.dispatchFetch("https://agent.example.invalid/status",{headers:{cookie:`__Host-cloud_agent_session=${session}`}});const status=await restarted.json();assert.equal(status.inferenceReady,true);assert.equal(status.provider,"codex");assert.equal(status.inferencePreference,"auto");assert.equal(status.directUsageGranted,true,"legacy scope fact stays authentic");assert.equal(status.capabilities.images,true);
 await github({initialize:true});const githubNative=await github({prompt:"Native authoring",operationId:"github-native"});assert.equal(githubNative.status,200,await githubNative.clone().text());assert.equal((await githubNative.json()).text,"NATIVE_SUBSCRIPTION_OK");assert.equal(backend.at(-1).url,"https://chatgpt.com/backend-api/codex/responses");
 providerFailure=true;const oldFailed=await (await ask({manual:true,prompt:"Existing native denial",operationId:"fixture-old-native-denied"})).json();assert.equal(oldFailed.status,"unanswered");providerFailure=false;
 await mf.setOptions(convertV4MiniflareOptions({...config,bindings:{...config.bindings,SUBSCRIPTION_INFERENCE_PROVIDER:"siwc"}}));
 const selectedStatus=await (await direct("/status")).json();
 assert.equal(selectedStatus.provider,"siwc","global SIWC-only policy selects retained SIWC despite unified Codex");
 assert.equal(selectedStatus.inferencePreference,"siwc");assert.equal(selectedStatus.inferenceReady,true);assert.equal(selectedStatus.capabilities.inference,true);assert.equal(selectedStatus.capabilities.images,true);
 assert.equal(selectedStatus.codexInferenceReady,true);assert.equal(selectedStatus.siwcInferenceReady,true);assert.equal(selectedStatus.image.provider,"codex");
 assert.equal(selectedStatus.identity.planType,"enterprise");assert.equal(selectedStatus.planClaim,"enterprise");assert.equal(selectedStatus.image.identity.planType,"plus");assert.equal(selectedStatus.endpoint,"https://api.openai.com/v1/responses");
 const exported=await (await direct("/export")).json();await direct("/copy",exported,peer);

 const peerStatus=await (await direct("/status",undefined,peer)).json();assert.equal(peerStatus.provider,"siwc","all accounts use global SIWC selection");assert.equal(peerStatus.inferenceReady,true);
 const selectedSnapshot=await (await ask({snapshot:true})).json();assert.equal(selectedSnapshot.model.provider,"openai");assert.equal(selectedSnapshot.model.id,snapshot.model.id);assert.equal(selectedSnapshot.accountId,snapshot.accountId);assert.equal(selectedSnapshot.sessionId,snapshot.sessionId);
 const selectedAsk=await ask({manual:true,prompt:"Explicit SIWC selection",operationId:"fixture-selected"});assert.equal(selectedAsk.status,200,await selectedAsk.clone().text());assert.equal((await selectedAsk.json()).text,"NATIVE_SUBSCRIPTION_OK");assert.equal(backend.at(-1).url,"https://api.openai.com/v1/responses");
 const selectedAdmission=await (await ask({admission:"fixture-selected"})).json();assert.deepEqual(selectedAdmission.snapshot,selectedSnapshot);
 const replayBefore=backend.length;await ask({manual:true,prompt:"After unified login",operationId:"fixture-unified"});await ask({manual:true,prompt:"Before login",operationId:"fixture-before"});assert.equal(backend.length,replayBefore,"completed native and SIWC operations replay under selection without new provider calls");
 assert.equal((await (await ask({admission:"fixture-unified"})).json()).snapshot.model.provider,"openai-codex");
 const nativeAccessBefore=(await (await direct("/codex-access-calls")).json()).count,blockedBefore=backend.length;
 const stoppedNative=await (await ask({prompt:"Old pending native operation",operationId:"fixture-old-native-pending",pinned:snapshot})).json();assert.equal(stoppedNative.status,"unanswered");assert(JSON.stringify(stoppedNative).includes("subscription_inference_provider_disabled"),"pending native snapshot returns finite provider-disabled error");assert.equal(backend.length,blockedBefore);assert.equal((await (await direct("/codex-access-calls")).json()).count,nativeAccessBefore,"ordinary native guard precedes credential access");
 await ask({manual:true,prompt:"Existing native denial",operationId:"fixture-old-native-denied"});assert.equal(backend.length,blockedBefore,"failed native operation remains historical without resubmission");
 const githubSelected=await github({prompt:"SIWC authoring",operationId:"github-siwc"});assert.equal(githubSelected.status,200,await githubSelected.clone().text());assert.equal((await githubSelected.json()).text,"NATIVE_SUBSCRIPTION_OK");assert.equal(backend.at(-1).url,"https://api.openai.com/v1/responses");
 const authoringBefore=backend.length;await github({prompt:"Native authoring",operationId:"github-native"});assert.equal(backend.length,authoringBefore,"completed native GitHub replay stays cached");
 const pinnedAuthoring={prompt:"Pending native authoring",operationId:"github-pending-native"};await github({pin:{id:pinnedAuthoring.operationId,request:hash(JSON.stringify(pinnedAuthoring)),model:snapshot.model}});const blockedAuthoring=await github(pinnedAuthoring);assert.equal(blockedAuthoring.status,200,await blockedAuthoring.clone().text());assert.equal((await blockedAuthoring.json()).status,"unanswered");assert.equal(backend.length,authoringBefore,"pending native GitHub snapshot blocked without credential or provider request");assert.equal((await (await direct("/codex-access-calls")).json()).count,nativeAccessBefore);
 const authoringAdmissions=await (await github({admissions:true})).json();assert.equal(JSON.parse(authoringAdmissions.find(row=>row.id==='github-native').model).provider,"openai-codex");assert.equal(JSON.parse(authoringAdmissions.find(row=>row.id==='github-pending-native').model).provider,"openai-codex");assert.equal(JSON.parse(authoringAdmissions.find(row=>row.id==='github-siwc').model).provider,"openai");
 const bridgeNative=await bridge();assert.equal(bridgeNative.status,200,await bridgeNative.clone().text());assert.equal((await bridgeNative.json()).events.at(-1).type,"done");assert.equal(backend.at(-1).url,"https://chatgpt.com/backend-api/codex/responses","explicit native bridge stays native under ordinary SIWC selection");
 assert.equal((await direct("/image")).status,200);assert.equal(backend.at(-1).url,"https://chatgpt.com/backend-api/codex/images/generations");
 for(const absent of [{missing:true},{scopes:["resource.invoke"]},{scopes:["chatgpt.tokens.use.direct"]}]){
  await direct("/legacy",absent);const unavailable=await (await direct("/status")).json();assert.equal(unavailable.provider,"siwc");assert.equal(unavailable.connected,true,"native images keep an account connected");assert.equal(unavailable.inferenceReady,false);assert.equal(unavailable.siwcInferenceReady,false);assert.equal(unavailable.capabilities.inference,false);assert.equal(unavailable.capabilities.images,true);assert.equal(unavailable.codexInferenceReady,true);
  const count=backend.length;const refused=await ask({manual:true,prompt:"Unavailable SIWC",operationId:"fixture-missing"});assert.equal(refused.status,400);assert.equal((await refused.json()).error,"account_not_connected");assert.equal(backend.length,count,"no native fallback or request with ungranted SIWC");
  const token=await direct("/legacy-access");assert.equal(token.status,400);assert.match((await token.json()).error,/^(login_required|plan_usage_scope_missing)$/);await direct("/copy",exported);
 }
 await direct("/legacy",{scopes:["resource.invoke","chatgpt.tokens.use.direct"],expiresAt:Date.now()+240000});
 const beforeRefresh=await (await direct("/status")).json();assert(beforeRefresh.expiresAt<beforeRefresh.image.expiresAt,"selected expiry belongs to the legacy grant");
 const refreshed=await direct("/refresh-status");assert.equal(refreshed.status,200,await refreshed.clone().text());const refreshedStatus=await refreshed.json();assert.equal(legacyRefreshCalls,1);assert.equal(refreshCalls,0,"information refresh targets selected SIWC, leaving native grant untouched");assert.equal(refreshedStatus.provider,"siwc");assert.equal(refreshedStatus.identity.planType,"enterprise");assert.equal(refreshedStatus.identityRefreshStatus,"not_returned");assert(refreshedStatus.expiresAt>beforeRefresh.expiresAt);
 legacyRefreshIdentity=true;const identityRefreshed=await (await direct("/refresh-status")).json();assert.equal(identityRefreshed.identityRefreshStatus,"updated");assert.equal(identityRefreshed.identity.planType,"business");assert.equal(identityRefreshed.planClaim,"business");assert.equal(identityRefreshed.image.identity.planType,"plus");assert.equal(legacyRefreshCalls,2);assert.equal(refreshCalls,0);legacyRefreshIdentity=false;
 providerFailure=true;const deniedBefore=backend.length;const selectedDenied=await (await ask({manual:true,prompt:"SIWC denial",operationId:"fixture-siwc-denied"})).json();assert.equal(selectedDenied.status,"unanswered");assert.equal(backend.length,deniedBefore+1);assert.equal(backend.at(-1).url,"https://api.openai.com/v1/responses");providerFailure=false;
 await configure({SUBSCRIPTION_INFERENCE_PROVIDER:"auto"});
 const retainedReplay=backend.length;await ask({manual:true,prompt:"Explicit SIWC selection",operationId:"fixture-selected"});await ask({manual:true,prompt:"SIWC denial",operationId:"fixture-siwc-denied"});assert.equal(backend.length,retainedReplay,"policy changes preserve successful and failed snapshots without resubmission");assert.equal((await (await ask({admission:"fixture-selected"})).json()).snapshot.model.provider,"openai");
 await configure({SUBSCRIPTION_INFERENCE_PROVIDER:"auto",INFERENCE_BRIDGE_PROVIDER:"siwc"});assert.equal((await bridge()).status,200);assert.equal(backend.at(-1).url,"https://api.openai.com/v1/responses","explicit SIWC bridge stays SIWC under native ordinary selection");
 providerFailure=true;const nativeDeniedBefore=backend.length;const nativeDenied=await (await ask({manual:true,prompt:"Native denial",operationId:"fixture-native-denied"})).json();assert.equal(nativeDenied.status,"unanswered");assert.equal(backend.length,nativeDeniedBefore+1);assert.equal(backend.at(-1).url,"https://chatgpt.com/backend-api/codex/responses");providerFailure=false;
 const invalid=["","codex","SIWC"," siwc","siwc ","{}","[]","null","unknown"];
 const invalidBefore=backend.length;for(const policy of invalid){await configure({SUBSCRIPTION_INFERENCE_PROVIDER:policy});for(const path of ["/status-guard","/refresh-guard"]){const rejected=await direct(path);assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,"subscription_inference_policy_invalid","global policy validates before credential reads");}}assert.equal(backend.length,invalidBefore);
 await configure({SUBSCRIPTION_INFERENCE_PROVIDER:"auto"});assert.equal((await (await direct("/status")).json()).provider,"codex");assert.equal((await (await direct("/status",undefined,peer)).json()).provider,"codex");
 await configure({SUBSCRIPTION_INFERENCE_PROVIDER:"auto",OPENAI_MODEL:"gpt-4.1",ALLOWED_OPENAI_MODELS:'["gpt-4.1","gpt-6.1-sol"]'});
 const onlySiwc=await ask({change:"gpt-4.1"});assert.equal(onlySiwc.status,400,"native provider catalog excludes public-only model");
 await configure({SUBSCRIPTION_INFERENCE_PROVIDER:"siwc",ALLOWED_OPENAI_MODELS:'["gpt-4.1","gpt-6.1-sol"]'});const publicModel=await ask({change:"gpt-4.1"});assert.equal(publicModel.status,200,await publicModel.clone().text());assert.equal((await publicModel.json()).model.provider,"openai");await ask({change:"gpt-6.1-sol"});
 await mf.setOptions(convertV4MiniflareOptions(config));
 await direct("/expire");await Promise.all([direct("/access"),direct("/image-access")]);assert.equal(refreshCalls,1,"image and inference share one refresh");
 const settings=await (await ask({settings:true})).json();assert(settings.models.some(model=>model.id==="gpt-6.1-sol"));
 const changedModel=await (await ask({change:"gpt-6.1-sol"})).json();assert.equal(changedModel.model.provider,"openai-codex");
 const beforeFailure=backend.length;refreshFailure=true;const forcedFailure=await direct("/force-access");assert.equal(forcedFailure.status,400);refreshFailure=false;
 const blocked=await direct("/access");assert.equal(blocked.status,400);assert.equal((await blocked.json()).error,"codex_image_refresh_failed_restart_login","unexpired old bearer is never returned after uncertain forced refresh");
 const needsReconnect=await mf.dispatchFetch("https://agent.example.invalid/status",{headers:{cookie:`__Host-cloud_agent_session=${session}`}});const blockedStatus=await needsReconnect.json();assert.equal(blockedStatus.provider,"codex");assert.equal(blockedStatus.inferenceReady,false);assert.equal(backend.length,beforeFailure);
 assert.equal((await start()).status,200);assert.equal((await complete()).status,200);
 await direct("/expire");accessAccount="other-account";const wrongAccess=await direct("/access");assert.equal(wrongAccess.status,400);assert.equal((await wrongAccess.json()).error,"codex_access_account_mismatch");accessAccount="fixture-account";
 assert.equal((await start()).status,200);assert.equal((await complete()).status,200);
 assert.equal((await post("/api/accounts/disconnect",{id:"owner",confirmed:true})).status,200);
 await direct("/unpin-legacy-workspace");
 const retainedPin=await (await direct("/inspect")).json();assert(retainedPin.registration.ciphertext,"Codex identity survives disconnect");
 overrides={sub:"same-email-other-subject"};assert.equal((await start()).status,200);const wrongSubject=await complete();assert.equal(wrongSubject.status,400);assert.equal((await wrongSubject.json()).error,"codex_image_identity_mismatch");
 overrides={"https://api.openai.com/auth":{chatgpt_account_id:"same-email-other-workspace",chatgpt_plan_type:"plus"}};accessAccount="same-email-other-workspace";assert.equal((await start()).status,200);const wrongWorkspace=await complete();assert.equal(wrongWorkspace.status,400);assert.equal((await wrongWorkspace.json()).error,"codex_image_identity_mismatch","independent Codex pin survives disconnect even without legacy account pin");
 overrides={};accessAccount="fixture-account";assert.equal((await start()).status,200);assert.equal((await complete()).status,200,"same pinned identity can reconnect");
 await direct("/pin-other");const changed=await direct("/access");assert.equal(changed.status,400);assert.equal((await changed.json()).error,"codex_image_identity_policy_changed");
 assert.equal((await post("/api/accounts/disconnect",{id:"owner"})).status,400);assert.equal((await post("/api/accounts/disconnect",{id:"owner",confirmed:true})).status,200);
 const disconnected=await (await direct("/inspect")).json();assert.equal(disconnected.profile,undefined);assert.equal(disconnected.credential,undefined);
 console.log("Native subscription checks passed: global SIWC-only/default-auto policy, both accounts, both scopes, selected identity/expiry/refresh, immutable manual/GitHub snapshots/replays, pending native guards before credentials/fetch, independent bridge and native images, actual Pi success/403 and provider catalogs, RS256/JWKS/encrypted restart, identity pins and SSO/CSRF. Provider endpoints mocked; live login pending.");
}finally{await mf.dispose();await rm(persist,{recursive:true,force:true});}
