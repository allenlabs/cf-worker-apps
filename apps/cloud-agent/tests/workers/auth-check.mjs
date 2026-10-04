import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const bearer = randomBytes(32).toString("hex");
const email = "fixture@example.invalid";
await writeFile("build/pi/check-wrapper.js", `import worker, { Assistant as BaseAssistant, Credentials as BaseCredentials } from './index.js';
const originalFetch = globalThis.fetch;
let providerAbortSignals = 0;
globalThis.fetch = (input, init) => {
  if (String(input).includes('/responses')) init?.signal?.addEventListener('abort', () => { providerAbortSignals++; }, { once: true });
  return originalFetch(input, init);
};
export default worker;
export class Assistant extends BaseAssistant {
  async fetch(request) {
    if(new URL(request.url).pathname==='/test-models')return Response.json({choices:this.allowedModels().map(({id,label})=>({id,label})),aliases:['1','빠르게','2','기본','3','깊게','openai/gpt-6-astra'].map(value=>this.selectedModel(value).id)});
    if(new URL(request.url).pathname==='/test-account'){this.saveRuntime({accountId:(await request.json()).accountId,sessionId:'1',names:{}});return Response.json({ok:true});}
    if(new URL(request.url).pathname==='/test-ask'){try{const body=await request.json();return Response.json(await (body.accountId?this.manualAsk(body.prompt,body.operationId,body.accountId):this.ask(body.prompt,body.operationId)));}catch(error){return Response.json({error:error.message},{status:400});}}
    return Response.json({ probing: !!this.probing, pending: await this.harness.pending(), busy: await this.harness.session().busy(), providerAbortSignals });
  }
}
export class Credentials extends BaseCredentials {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if(path==='/oauth/start')return Response.json(await this.start((await request.json()).planUsageConfirmed));
      if(path==='/oauth/complete')return Response.json(await this.complete((await request.json()).callbackUrl));
      if(path==='/status')return Response.json(await this.status());
      if(path==='/configure')return Response.json(await this.configureAccount(await request.json()));
      if(path==='/disconnect')return Response.json(await this.disconnect());
      if(path==='/refresh')return Response.json(await this.refreshStatus());
      if(path==='/test-legacy'){await this.ctx.storage.delete('identity');const registration=await this.ctx.storage.get('registration');delete registration.planUsageConfirmed;await this.ctx.storage.put('registration',{...registration,personalProConfirmed:true,plan:'pro'});return Response.json({ok:true});}
      return Response.json({ credential: await this.ctx.storage.get('credential'), pending: await this.ctx.storage.get('pending'), host: await this.ctx.storage.get('host'), registration: await this.ctx.storage.get('registration'), identity: await this.ctx.storage.get('identity') });
    } catch(error){return Response.json({error:error.message},{status:400});}
  }
}`);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
let nonce;
let claimsOverride = {};
let tokenOverride = {};
let tokenCalls = 0, refreshCalls = 0, jwksCalls = 0, responsesCalls = 0;
let firstExpiry = 3600;
let refreshClaims = null;
const jwt = (overrides = claimsOverride) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: "fixture-client", sub: "fixture-sub", email, email_verified: true, nonce, exp: Date.now() / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "fixture-account" }, ...overrides })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url")}`;
};
const config = {
  name: "cloud-agent",
  modulesRoot: resolve("build/pi"),
  modules: ["check-wrapper.js", "index.js"].map(name => ({ type: "ESModule", path: resolve("build/pi", name) })),
  compatibilityDate: "2026-10-04",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { Assistant: { className: "Assistant", useSQLite: true }, Credentials: { className: "Credentials", useSQLite: true } },
  bindings: { OWNER_EMAIL_SHA256: createHash("sha256").update(email).digest("hex"), TOKEN_WRAPPING_AAD: "fixture-cloud-agent/v1", PROBE_MODE: "subscription", OPENAI_MODEL: "gpt-6.1-sol", ALLOWED_OPENAI_MODELS:'["gpt-6-luna","gpt-6.1-sol","gpt-6-astra"]', PROBE_DEADLINE_MS: "150", TOKEN_WRAPPING_KEY: randomBytes(32).toString("base64url"), PROBE_KEY_SHA256: createHash("sha256").update(bearer).digest("hex"), PUBLIC_ORIGIN: "https://probe.invalid", PRODUCT_NAME: "Fixture Cloud Agent" },
  outboundService: async request => {
    if (request.url === "https://auth.openai.com/.well-known/jwks.json") { jwksCalls++; return Response.json({ keys: [jwk] }); }
    if (request.url === "https://auth.openai.com/api/accounts/oauth/token") {
      tokenCalls++;
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_id"), "fixture-client");
      assert.equal(body.get("resource"), "https://api.openai.com/v1");
      if (body.get("grant_type") === "refresh_token") {
        refreshCalls++;
        assert.ok(["fake-refresh", "fake-rotated-refresh"].includes(body.get("refresh_token")));
        await new Promise(resolve => setTimeout(resolve, 30));
        return Response.json({ access_token: "fake-renewed-access", refresh_token: "fake-rotated-refresh", expires_in: 3600, token_type: "Bearer", scope: "resource.invoke chatgpt.tokens.use.direct", ...(refreshClaims ? {id_token:jwt(refreshClaims)} : {}) });
      }
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "fixture-code");
      assert.equal(body.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
      assert.match(body.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", id_token: jwt(), expires_in: firstExpiry, token_type: "Bearer", scope: "resource.invoke chatgpt.tokens.use.direct", ...tokenOverride });
    }
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    responsesCalls++;
    assert.equal(request.headers.get("authorization"), "Bearer fake-renewed-access");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress"}}\n\n')); } }), { headers: { "Content-Type": "text/event-stream" } });
  }
};
const mf = new Miniflare(convertV4MiniflareOptions(config));
const send = async (path, options = {}) => {
  const namespace = await mf.getDurableObjectNamespace(path.startsWith('/ask') ? 'Assistant' : 'Credentials');
  const stub = namespace.get(namespace.idFromName(path.startsWith('/ask') ? 'manual-test' : 'owner'));
  return stub.fetch('https://probe.invalid'+(path.startsWith('/ask') ? '/test-ask' : path),options);
};
const post = (path, body, options = {}) => send(path, { method: "POST", body: JSON.stringify(body), ...options });
const start = async () => {
  const response = await post("/oauth/start", { planUsageConfirmed: true });
  assert.equal(response.status, 200, await response.clone().text());
  const authorization = new URL((await response.json()).authorizationUrl);
  nonce = authorization.searchParams.get("nonce");
  assert.equal(authorization.origin, "https://auth.openai.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.match(authorization.searchParams.get("ext_agent_host_id"), /^urn:uuid:/);
  return authorization;
};
const callback = auth => `http://127.0.0.1:1455/auth/callback?${new URLSearchParams({ code: "fixture-code", client_id: "fixture-client", state: auth.searchParams.get("state"), iss: "https://auth.openai.com" })}`;
const complete = auth => post("/oauth/complete", { callbackUrl: callback(auth) });
const inspectCredentials = async () => {
  const namespace = await mf.getDurableObjectNamespace("Credentials");
  return (await namespace.get(namespace.idFromName("owner")).fetch("https://probe.invalid/test-state")).json();
};
try {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({ ...config, bindings: { ...config.bindings, OWNER_EMAIL_SHA256: "" } }));
  try {
    const namespace = await unconfigured.getDurableObjectNamespace("Credentials");
    const denied = await namespace.get(namespace.idFromName("owner")).fetch("https://probe.invalid/oauth/start", { method: "POST", body: JSON.stringify({ planUsageConfirmed: true }) });
    assert.equal(denied.status, 400); assert.equal((await denied.json()).error, "account_policy_missing"); assert.equal(tokenCalls, 0);
  } finally { await unconfigured.dispose(); }
  assert.equal((await post("/oauth/start", { planUsageConfirmed: false })).status,400);
  let auth = await start();
  assert.equal(auth.searchParams.get("agent_name_hint"), "Fixture Cloud Agent");
  const firstHost = auth.searchParams.get("ext_agent_host_id");
  const sealedAttempt = (await inspectCredentials()).pending;
  const testKey = await crypto.subtle.importKey("raw", Buffer.from(config.bindings.TOKEN_WRAPPING_KEY, "base64url"), "AES-GCM", false, ["decrypt"]);
  const aadParameters = { name: "AES-GCM", iv: Buffer.from(sealedAttempt.iv, "base64url"), additionalData: new TextEncoder().encode(config.bindings.TOKEN_WRAPPING_AAD) };
  const openedAttempt = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(aadParameters, testKey, Buffer.from(sealedAttempt.ciphertext, "base64url"))));
  assert.equal(openedAttempt.nonce, nonce);
  await assert.rejects(crypto.subtle.decrypt({ ...aadParameters, additionalData: new TextEncoder().encode("wrong-instance/v1") }, testKey, Buffer.from(sealedAttempt.ciphertext, "base64url")));

  const beforeBad = tokenCalls;
  const badCallbacks = [
    callback(auth).replace("state=", "state=wrong"),
    callback(auth).replace("127.0.0.1:1455", "evil.invalid"),
    `${callback(auth)}&state=duplicate`,
    callback(auth).replace("iss=https%3A%2F%2Fauth.openai.com", "iss=https%3A%2F%2Fevil.invalid")
  ];
  for (const value of badCallbacks) {
    auth = await start();
    const bad = value.includes("state=wrong") ? callback(auth).replace("state=", "state=wrong") : value.includes("evil.invalid") ? callback(auth).replace(value.includes("127.0.0.1:1455") ? "iss=https%3A%2F%2Fauth.openai.com" : "127.0.0.1:1455", value.includes("127.0.0.1:1455") ? "iss=https%3A%2F%2Fevil.invalid" : "evil.invalid") : `${callback(auth)}&state=duplicate`;
    assert.equal((await post("/oauth/complete", { callbackUrl: bad })).status, 400);
    assert.equal((await complete(auth)).status, 400);
  }
  assert.equal(tokenCalls, beforeBad);
  for (const change of [{ nonce: "wrong" }, { aud: "wrong" }, { iss: "https://evil.invalid" }, { exp: Date.now() / 1000 - 1 }, { email: "other@example.invalid" }, { "https://api.openai.com/auth": { chatgpt_account_id: 42 } }]) {
    claimsOverride = change;
    auth = await start();
    const rejected = await complete(auth);
    assert.equal(rejected.status, 400, await rejected.clone().text());
    assert.equal((await (await send("/status")).json()).connected, false);
  }
  claimsOverride = {};
  for (const scope of ["resource.invoke", "chatgpt.tokens.use.direct"]) {
    tokenOverride = { scope }; auth = await start();
    assert.equal((await complete(auth)).status, 400);
  }
  tokenOverride = {}; firstExpiry = 1;
  for (const planType of ["plus", "business", "unknown-plan", null]) {
    claimsOverride = {"https://api.openai.com/auth": {chatgpt_account_id:"fixture-account", ...(planType ? {chatgpt_plan_type:planType} : {})}};
    auth = await start(); const accepted = await complete(auth);
    assert.equal(accepted.status,200,await accepted.clone().text());
    const metadata=(await accepted.json()).identity;
    assert.equal(metadata.source,"verified_id_token");assert.equal(metadata.email,email);assert.equal(metadata.planType,planType);
    assert.equal(metadata.accountId,"fixture-account");assert.equal(metadata.workspace,null);assert.equal(metadata.organizations,null);
  }
  claimsOverride = {email:" FIXTURE@EXAMPLE.INVALID ",name:"n".repeat(257),"https://api.openai.com/auth": {chatgpt_plan_type:"business",chatgpt_account_id:"fixture-account",workspace:{id:"explicit-workspace",title:"Verified workspace",unexpected:"not stored"},organizations:Array.from({length:22},(_,i)=>({id:"org-"+i,title:"Org "+i,role:"member",is_default:i===0,unexpected:"not stored"}))}};
  auth = await start();
  assert.equal(auth.searchParams.get("ext_agent_host_id"), firstHost);
  const connected = await complete(auth);
  assert.equal(connected.status, 200, await connected.clone().text());
  const status = await connected.json();
  assert.equal(status.connected, true);
  assert.equal(status.identityVerified, true);
  assert.equal(status.directUsageGranted, true);
  assert.equal(status.automaticInference, false);
  assert.equal(status.planUsageConfirmed,true);assert.equal(status.identity.name,null);assert.equal(status.identity.email,email);assert.equal(status.identity.planType,"business");
  assert.deepEqual(status.identity.workspace,{id:"explicit-workspace",title:"Verified workspace"});assert.equal(status.identity.organizations.length,20);
  assert.deepEqual(status.identity.organizations[0],{id:"org-0",title:"Org 0",role:"member",isDefault:true});assert.ok(!JSON.stringify(status.identity).includes("unexpected"));
  const stored = await inspectCredentials();
  assert.ok(stored.credential.ciphertext);assert.ok(stored.identity.ciphertext);
  for(const plain of ["fake-refresh",email,"explicit-workspace","Verified workspace","org-0","business"])assert.ok(!JSON.stringify(stored).includes(plain));
  assert.equal(stored.pending, undefined);
  const firstPinned = await start();
  assert.equal(firstPinned.searchParams.get("client_id"), "fixture-client");
  assert.equal(firstPinned.searchParams.has("agent_name_hint"), false);
  claimsOverride = { sub: "another-sub" };
  assert.equal((await complete(firstPinned)).status, 400);
  claimsOverride = {};
  const namespace = await mf.getDurableObjectNamespace("Credentials");
  const owner = namespace.get(namespace.idFromName("owner"));
  const refreshed = await Promise.all([owner.access(), owner.access(), owner.access()]);
  assert.deepEqual(refreshed, Array(3).fill("fake-renewed-access"));
  assert.equal(refreshCalls, 1);
  assert.deepEqual((await inspectCredentials()).identity,stored.identity,"refresh without id_token preserves sealed metadata");
  assert.deepEqual((await inspectCredentials()).registration,stored.registration);
  const beforeForce=refreshCalls;
  refreshClaims={"https://api.openai.com/auth":{chatgpt_plan_type:"plus",chatgpt_account_id:"fixture-account"}};
  const refreshedStatus=await Promise.all([owner.refreshStatus(),owner.refreshStatus(),owner.refreshStatus()]);
  assert.equal(refreshCalls,beforeForce+1);assert.ok(refreshedStatus.every(item=>item.identity.planType==="plus"&&item.identityRefreshStatus==="updated"));
  const preservedRefresh=await inspectCredentials();refreshClaims={sub:"another-sub"};
  const invalidRefresh=await post("/refresh",{});assert.equal(invalidRefresh.status,400);assert.equal((await invalidRefresh.json()).error,"selected_user_mismatch");
  assert.deepEqual((await inspectCredentials()).credential,preservedRefresh.credential);assert.deepEqual((await inspectCredentials()).identity,preservedRefresh.identity);assert.deepEqual((await inspectCredentials()).registration,preservedRefresh.registration);
  refreshClaims=null;await post("/test-legacy",{});const legacy=await inspectCredentials();
  const legacyStatus=await owner.refreshStatus();assert.equal(legacyStatus.connected,true);assert.equal(legacyStatus.identity,null);assert.equal(legacyStatus.identityRefreshStatus,"not_returned");assert.equal(legacyStatus.planUsageConfirmed,true);assert.equal(legacyStatus.planClaim,"pro");
  assert.deepEqual((await inspectCredentials()).registration,legacy.registration);
  refreshClaims={email:undefined,"https://api.openai.com/profile":{email,name:"Verified profile"},"https://api.openai.com/auth":{chatgpt_plan_type:"business",chatgpt_account_id:"fixture-account"}};
  const profileStatus=await owner.refreshStatus();assert.equal(profileStatus.identityRefreshStatus,"updated");assert.equal(profileStatus.identity.email,email);assert.equal(profileStatus.identity.name,"Verified profile");assert.equal(profileStatus.identity.planType,"business");refreshClaims=null;
  const started = Date.now();
  const asked = await post("/ask?thread=deadline", { prompt: "Timeout fixture", operationId: "timeout-1" });
  assert.equal(asked.status, 200, await asked.clone().text());
  const result = await asked.json();
  assert.equal(result.status, "unanswered");
  assert.equal(result.error, "generation_timeout");
  assert.ok(Date.now() - started < 10000);
  const assistantNamespace = await mf.getDurableObjectNamespace("Assistant");
  const modelChoices=await (await assistantNamespace.get(assistantNamespace.idFromName('model-choices')).fetch('https://probe.invalid/test-models')).json();
  assert.deepEqual(modelChoices.choices.map(item=>item.id),['gpt-6-luna','gpt-6.1-sol','gpt-6-astra']);
  assert.deepEqual(modelChoices.aliases,['gpt-6-luna','gpt-6-luna','gpt-6.1-sol','gpt-6.1-sol','gpt-6-astra','gpt-6-astra','gpt-6-astra']);
  const actualState = await (await assistantNamespace.get(assistantNamespace.idFromName("manual-test")).fetch("https://probe.invalid/test-state")).json();
  assert.equal(actualState.probing, false);
  assert.deepEqual(actualState.pending, []);
  assert.equal(actualState.busy, false);
  assert.ok(actualState.providerAbortSignals > 0);
  assert.equal(responsesCalls, 1);
  const text = JSON.stringify(await (await send("/status")).json());
  for (const secret of [bearer, "fake-access", "fake-refresh", "fake-renewed-access", "fixture-code", nonce]) assert.ok(!text.includes(secret));
  const preservedRegistration=(await inspectCredentials()).registration;
  assert.equal((await post('/disconnect',{})).status,200);
  assert.equal((await (await send('/status')).json()).connected,false);
  assert.deepEqual((await inspectCredentials()).registration,preservedRegistration);
  assert.equal((await inspectCredentials()).host,stored.host);
  const customId='account-11111111-1111-4111-8111-111111111111';
  const custom=namespace.get(namespace.idFromName(customId));
  const configured=await custom.fetch('https://probe.invalid/configure',{method:'POST',body:JSON.stringify({expectedEmailHash:createHash('sha256').update('different@example.invalid').digest('hex'),label:'Another account'})});
  assert.equal(configured.status,200);
  assert.equal((await custom.fetch('https://probe.invalid/configure',{method:'POST',body:JSON.stringify({expectedEmailHash:createHash('sha256').update('different@example.invalid').digest('hex'),label:'a'.repeat(128)})})).status,200);
  assert.equal((await custom.fetch('https://probe.invalid/configure',{method:'POST',body:JSON.stringify({expectedEmailHash:createHash('sha256').update('different@example.invalid').digest('hex'),label:'가'.repeat(43)})})).status,400);
  const customAuth=new URL((await (await custom.fetch('https://probe.invalid/oauth/start',{method:'POST',body:JSON.stringify({planUsageConfirmed:true})})).json()).authorizationUrl);
  nonce=customAuth.searchParams.get('nonce');
  const wrongIdentity=await custom.fetch('https://probe.invalid/oauth/complete',{method:'POST',body:JSON.stringify({callbackUrl:callback(customAuth)})});
  assert.equal(wrongIdentity.status,400);assert.equal((await wrongIdentity.json()).error,'selected_email_mismatch');
  const connectedId='account-22222222-2222-4222-8222-222222222222';
  const selected=namespace.get(namespace.idFromName(connectedId));
  assert.equal((await selected.fetch('https://probe.invalid/configure',{method:'POST',body:JSON.stringify({expectedEmailHash:createHash('sha256').update(email).digest('hex'),label:'Pinned fixture'})})).status,200);
  const selectedAuth=new URL((await (await selected.fetch('https://probe.invalid/oauth/start',{method:'POST',body:JSON.stringify({planUsageConfirmed:true})})).json()).authorizationUrl);
  nonce=selectedAuth.searchParams.get('nonce');
  assert.equal((await selected.fetch('https://probe.invalid/oauth/complete',{method:'POST',body:JSON.stringify({callbackUrl:callback(selectedAuth)})})).status,200);
  const testAgent=assistantNamespace.get(assistantNamespace.idFromName('manual-test'));
  await testAgent.fetch('https://probe.invalid/test-account',{method:'POST',body:JSON.stringify({accountId:connectedId})});
  config.bindings.TEST_RESTART='true';await mf.setOptions(convertV4MiniflareOptions(config));
  const beforeRestartAsk=responsesCalls;
  const restartedResult=await post('/ask?thread=manual-test',{prompt:'Pinned account after restart',operationId:'after-restart-2'});
  assert.equal(restartedResult.status,200,await restartedResult.clone().text());
  assert.equal((await restartedResult.json()).error,'generation_timeout');assert.equal(responsesCalls,beforeRestartAsk+1);
  const restartedNamespace=await mf.getDurableObjectNamespace('Credentials');assert.equal((await restartedNamespace.get(restartedNamespace.idFromName('owner')).status()).connected,false,'owner remains disconnected, no fallback could issue a model call');
  console.log(JSON.stringify({ checks: "PASS", runtime: "workerd", credentialStorage: "AES-GCM in SQLite DO", configurableAAD: true, missingOwnerPolicyDenied: true, negativeCallbacks: true, jwtIdentityAndScope: true, stableHost: true, identityPin: true, customAccountEmailPolicy:true,multipleSubscriptionPlans:true,sealedVerifiedAccountMetadata:true,serializedMetadataRefresh:true,legacyMetadataPreservesGrant:true,failedRefreshPreservesPin:true, disconnectKeepsPinAndHost:true, nonOwnerAccountSurvivesIsolateRestart:true, refreshCalls, actualPiOperationAborted: true, deadlineMs: 150, responsesCalls, tokenCalls, jwksCalls, realOpenAINetworkCalls: 0 }));
} finally { await mf.dispose(); }
