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
await writeFile("build/pi/codex-images-wrapper.js", `import worker,{Assistant as BaseAssistant,Credentials as BaseCredentials} from './index.js';
import {codexImageRequest} from './codex-auth-fixture.js';
export default worker;
export class Assistant extends BaseAssistant {
 async fetch(request){try{const input=await request.json();if(input.forget){await this.ctx.storage.delete('manualOperation:'+input.forget);return Response.json({ok:true});}if(input.admission)return Response.json(await this.ctx.storage.get('manualOperation:'+input.admission));if(input.snapshot)return Response.json(await this.operationSnapshot());if(input.settings)return Response.json(await this.adminSettings());if(input.change){const snapshot=await this.operationSnapshot();await this.changeSettings('model',input.change,snapshot);return Response.json(await this.operationSnapshot());}if(input.manual)return Response.json(await this.manualAsk(input.prompt,input.operationId,'owner'));return Response.json(await this.ask(input.prompt,input.operationId,input.pinned));}catch(error){return Response.json({error:error.message},{status:400});}}
}
export class Credentials extends BaseCredentials {
 async fetch(request){try{const path=new URL(request.url).pathname;
  if(path==='/seed'){await this.ctx.storage.put({['adminSession:${hash(session)}']:{expiresAt:Date.now()+3600000,sealed:await this.seal({principal:{email:'${admin}',role:'super_admin',issuer:'https://sso.example.invalid',subject:'fixture-admin'},csrf:'${csrf}'})},registration:{clientId:'fixture-siwc-client',subjectHash:'${hash("legacy-subject")}',accountHash:'${hash("fixture-account")}',planUsageConfirmed:true},credential:await this.seal({clientId:'fixture-siwc-client',access:'fixture-siwc-access',refresh:'fixture-siwc-refresh',expiresAt:Date.now()+3600000,scopes:['resource.invoke','chatgpt.tokens.use.direct']})});return Response.json({ok:true});}
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
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-subscription-key", alg: "RS256", use: "sig" };
let issuedAccess, refreshFailure=false;
let overrides = {}, accessAccount = "fixture-account", pendingStatus = 200, exchangeCalls = 0, refreshCalls = 0, jwksCalls = 0;
const accessToken = () => `e30.${Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:accessAccount}})).toString("base64url")}.fixture-signature`;
const jwt = () => {
 const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
 const body = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: clientId, sub: "codex-subject-distinct-from-siwc", email, email_verified: true, exp: Date.now()/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:"fixture-account",chatgpt_plan_type:"plus"},...overrides})).toString("base64url");
 return `${header}.${body}.${sign("RSA-SHA256",Buffer.from(`${header}.${body}`),privateKey).toString("base64url")}`;
};
const verifier="fixture-code-verifier-abcdefghijklmnopqrstuvwxyz",challenge=createHash("sha256").update(verifier).digest("base64url"),backend=[];
const persist=await mkdtemp(join(tmpdir(),"codex-unified-native-"));
const sse = () => {
 const message={id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"NATIVE_SUBSCRIPTION_OK",annotations:[]}]};
 const events=[{type:"response.created",response:{id:"resp_fixture",status:"in_progress"}},{type:"response.output_item.added",output_index:0,item:{...message,status:"in_progress",content:[]}},{type:"response.content_part.added",item_id:message.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",item_id:message.id,output_index:0,content_index:0,delta:"NATIVE_SUBSCRIPTION_OK"},{type:"response.output_item.done",output_index:0,item:message},{type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[message],usage:{input_tokens:3,output_tokens:2,total_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
 return new Response(events.map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
};
const config={name:"cloud-agent",modulesRoot:resolve("build/pi"),modules:["codex-images-wrapper.js","index.js","codex-auth-fixture.js"].map(name=>({type:"ESModule",path:resolve("build/pi",name)})).concat(await piTextModules(resolve("build/pi"))),compatibilityDate:"2026-10-04",compatibilityFlags:["nodejs_compat"],durableObjects:{Credentials:{className:"Credentials",useSQLite:true},Assistant:{className:"Assistant",useSQLite:true}},d1Databases:["CONVERSATIONS"],resourcePersistencePath:persist,bindings:{PUBLIC_ORIGIN:"https://agent.example.invalid",OWNER_EMAIL_SHA256:hash(email),TOKEN_WRAPPING_KEY:randomBytes(32).toString("base64url"),CODEX_IMAGE_CLIENT_ID:clientId,SUPER_ADMIN_EMAILS:JSON.stringify([admin]),SSO_ISSUER:"https://sso.example.invalid",TENANT_ID:"fixture-tenant",PROBE_MODE:"subscription",OPENAI_MODEL:"gpt-6.1-sol",PROBE_DEADLINE_MS:"30000",IMAGE_PROVIDER:"codex"},outboundService:async request=>{
 if(request.url.endsWith("/.well-known/jwks.json")){jwksCalls++;return Response.json({keys:[jwk]});}
 if(request.url.endsWith("/deviceauth/usercode")){assert.deepEqual(await request.json(),{client_id:clientId});return Response.json({device_auth_id:"fixture-device",user_code:"FIXTURE-CODE",interval:"1"});}
 if(request.url.endsWith("/deviceauth/token")){assert.deepEqual(await request.json(),{device_auth_id:"fixture-device",user_code:"FIXTURE-CODE"});return pendingStatus===200?Response.json({authorization_code:"fixture-code",code_verifier:verifier,code_challenge:challenge}):new Response(null,{status:pendingStatus});}
 if(request.url==="https://auth.openai.com/oauth/token"){
  const raw=await request.text(),form=new URLSearchParams(raw),body=request.headers.get("content-type").includes("application/json")?JSON.parse(raw):Object.fromEntries(form);
  assert.equal(body.client_id,clientId);assert.equal(body.resource,undefined);
  if(body.grant_type==="refresh_token"){refreshCalls++;assert.equal(body.refresh_token,"fixture-codex-refresh");await new Promise(resolve=>setTimeout(resolve,30));}else exchangeCalls++;
  if(refreshFailure)return Response.json({error:"fixture unavailable"},{status:503});
  return Response.json({access_token:(issuedAccess=accessToken()),refresh_token:"fixture-codex-refresh",id_token:jwt(),expires_in:3600,token_type:"Bearer"});
 }
 const body=request.headers.get("content-encoding")==="zstd"?JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString()):await request.json();backend.push({url:request.url,body,authorization:request.headers.get("authorization"),account:request.headers.get("chatgpt-account-id"),accept:request.headers.get("accept")});
 if(request.url==="https://api.openai.com/v1/responses"){assert.equal(request.headers.get("authorization"),"Bearer fixture-siwc-access");return sse();}
 if(request.url==="https://chatgpt.com/backend-api/codex/images/generations"){assert.equal(request.headers.get("authorization"),`Bearer ${issuedAccess}`);assert.equal(request.headers.get("chatgpt-account-id"),"fixture-account");assert.equal(body.model,"gpt-image-2");return Response.json({data:[{b64_json:"Zml4dHVyZQ==",generation_id:"fixture-image"}]});}
 assert.equal(request.url,"https://chatgpt.com/backend-api/codex/responses");assert.equal(request.headers.get("authorization"),`Bearer ${issuedAccess}`);assert.equal(request.headers.get("chatgpt-account-id"),"fixture-account");assert.equal(request.headers.get("accept"),"text/event-stream");assert.equal(body.model,"gpt-6.1-sol");return sse();
}};
let mf=new Miniflare(convertV4MiniflareOptions(config));
const direct=async path=>{const ns=await mf.getDurableObjectNamespace("Credentials");return ns.get(ns.idFromName("owner")).fetch("https://fixture.invalid"+path);};
const ask=async body=>{const ns=await mf.getDurableObjectNamespace("Assistant");return ns.get(ns.idFromName("fixture-thread")).fetch("https://fixture.invalid/ask",{method:"POST",body:JSON.stringify(body)});};
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
 const restarted=await mf.dispatchFetch("https://agent.example.invalid/status",{headers:{cookie:`__Host-cloud_agent_session=${session}`}});const status=await restarted.json();assert.equal(status.inferenceReady,true);assert.equal(status.provider,"codex");assert.equal(status.directUsageGranted,true,"legacy scope fact stays authentic");assert.equal(status.capabilities.images,true);
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
 console.log("Native unified Codex checks passed: one RS256/JWKS device grant, real Pi Codex SSE, retained SIWC during pending/failure, snapshot transport pins, thread context, encrypted restart, shared refresh, token/account/registration rejection and SSO/CSRF. Provider endpoints mocked; live login pending.");
}finally{await mf.dispose();await rm(persist,{recursive:true,force:true});}
