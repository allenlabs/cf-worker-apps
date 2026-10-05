import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = await import(wranglerRequire.resolve("esbuild"));
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Script } from "node:vm";

const directory = await mkdtemp(join(tmpdir(), "cloud-agent-admin-check-"));
const entry = join(directory, "entry.js"), bundle = join(directory, "worker.js");
const origin = "https://cloud-agent.fixture.invalid", issuer = "https://sso.fixture.invalid/api/auth";
const admins = { "admin-one@example.invalid": "fixture-admin-one", "admin-two@example.invalid": "fixture-admin-two" };
const digest = value => createHash("sha256").update(value).digest("hex");
const operator = randomBytes(32).toString("hex");
await writeFile(entry, `import {ManagementCredentials,adminRoute} from ${JSON.stringify(resolve("workers/pi/admin.js"))};
import {conversationDatabase,objectKey,tenantId} from ${JSON.stringify(resolve("workers/pi/conversation-store.js"))};
export default {fetch:adminRoute};
export class Credentials extends ManagementCredentials {
 async seal(value){const iv=crypto.getRandomValues(new Uint8Array(12));const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(this.env.TOKEN_WRAPPING_KEY),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt']);return{iv:[...iv],ciphertext:[...new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value))))]};}
 async open(value){if(!value)return null;const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(this.env.TOKEN_WRAPPING_KEY),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['decrypt']);return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},key,new Uint8Array(value.ciphertext))));}
 async status(){const policy=await this.ctx.storage.get('identityPolicy');const identity=await this.open(await this.ctx.storage.get('verifiedIdentity'));const usage=await this.ctx.storage.get('fixtureUsage');return{label:policy?.label||'Legacy label',identity,usage:usage?{...usage,source:'pi_committed_usage',quota:null}:null,connected:!(await this.ctx.storage.get('disconnected')),subjectFingerprint:'fixture123',expiresAt:new Date(Date.now()+3600000).toISOString(),directUsageGranted:true};}
 async channelStatus(){return{enabled:true,source:'staff-only'};}
 async refreshStatus(){await this.ctx.storage.put('refreshed',true);return this.status();}
 async configureAccount(policy){await this.ctx.storage.put('identityPolicy',policy);await this.ctx.storage.put('disconnected',true);}
 async start(planUsageConfirmed){if(planUsageConfirmed!==true)throw Error('plan_usage_ui_unconfirmed');return{authorizationUrl:'https://auth.openai.com/fixture-authorize',manualCallbackRequired:true};}
 async complete(callback){if(!callback.startsWith('http://127.0.0.1:1455/auth/callback?'))throw Error('callback_uri_mismatch');await this.ctx.storage.put('disconnected',false);await this.ctx.storage.put('verifiedIdentity',await this.seal({source:new URL(callback).searchParams.get('identitySource')||'verified_id_token',email:'verified@example.invalid',planType:'plus',accountId:new URL(callback).searchParams.get('noAccountId')?null:'fixture-chatgpt-account',workspace:null,organizations:null,verifiedAt:new Date().toISOString()}));return this.status();}
 async disconnect(){await this.ctx.storage.put('disconnected',true);return this.status();}
 async recordMockUsage(operationId){if(await this.ctx.storage.get('usage:'+operationId))return;const previous=await this.ctx.storage.get('fixtureUsage')||{collectionStartedAt:new Date().toISOString(),input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0};await this.ctx.storage.put({'fixtureUsage':{...previous,lastUpdated:new Date().toISOString(),input:previous.input+5,output:previous.output+3,totalTokens:previous.totalTokens+8},['usage:'+operationId]:true});}
 async fetch(request){let assigned;const root=new URL(request.url).searchParams.get('root');if(root)assigned=await this.registerThread({channelId:'sample-channel',groupId:'sample-group',rootMessageId:root,threadKey:'channel-'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['sample-channel','sample-group',root]))))].map(x=>x.toString(16).padStart(2,'0')).join(''),accountId:new URL(request.url).searchParams.has('allocate')?undefined:'owner'});const version=new URL(request.url).searchParams.get('version');return Response.json({assigned,snapshot:await this.controlSnapshot(),manifest:version?await this.skillManifest(version):null,ciphertext:Object.fromEntries(await this.ctx.storage.list({prefix:'adminSession:'}))});}
}
export class Assistant extends ManagementCredentials {
 async history(){return[{role:'user',text:'fixture-history'}];}
 async channelHistory(){const db=await conversationDatabase(this.env),tenant=tenantId(this.env),key=objectKey('assistant',this.ctx.id.toString());await db.batch([db.prepare("INSERT OR IGNORE INTO ca_sessions(tenant_id,object_key,session_id,record) VALUES(?,?,1,?)").bind(tenant,key,JSON.stringify({id:1})),db.prepare("INSERT OR IGNORE INTO ca_entries(tenant_id,object_key,entry_id,session_id,commit_seq,entry) VALUES(?,?,2,1,1,?)").bind(tenant,key,JSON.stringify({id:2,conversationId:1,text:'fixture-thread-history'}))]);return{selected:{sessionId:'1'},receipts:[],entries:[]};}
 async ask(prompt,operationId){return{status:'done',text:prompt,operationId};}
 async manualAsk(prompt,operationId,accountId){const pinned=await this.ctx.storage.get('manualAccountId');if(pinned&&pinned!==accountId)throw Error('manual_account_mismatch');await this.ctx.storage.put('manualAccountId',accountId);await this.env.Credentials.getByName(accountId).recordMockUsage(operationId);return{status:'done',text:prompt,operationId,accountId};}
 async adminSettings(){return{selected:{sessionId:'fixture-session',accountId:'owner',name:await this.ctx.storage.get('sessionName')||''},model:{id:'fixture-model',label:'Fixture'},models:[{id:'fixture-model',label:'Fixture'}],thinking:{value:'medium',label:'Medium'},thinkingChoices:[{value:'medium',label:'Medium'}],sessions:[{id:'fixture-session',name:'Fixture session'}],userEntries:[{id:'fixture-entry',preview:'Fixture user message'}]};}
 async adminControl(input){if(input.args==='busy')throw Error('thread_busy');const receipt=await this.ctx.storage.get(input.operationId);if(receipt)return receipt;const executionCount=(await this.ctx.storage.get('controls')||0)+1;await this.ctx.storage.put('controls',executionCount);if(input.action==='name')await this.ctx.storage.put('sessionName',input.args);const result={operationId:input.operationId,status:'done',message:'Fixture control complete',settings:await this.adminSettings(),executionCount};await this.ctx.storage.put(input.operationId,result);return result;}
}`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", loader: { ".sql": "text" }, external: ["cloudflare:workers"] });
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "sso-fixture-key", alg: "EdDSA", use: "sig" };
let nonce, overrides = {}, tokenCalls = 0, userInfoCalls = 0, missingEmail = false;
const jwt = () => {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: jwk.kid })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: issuer, aud: "fixture-client", sub: admins["admin-one@example.invalid"], nonce, exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000, ...(!missingEmail ? { email: "admin-one@example.invalid", email_verified: true } : {}), ...overrides })).toString("base64url");
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};
const rawClientSecret = "fixture-sso-secret", hashedClientSecret = createHash("sha256").update(rawClientSecret).digest("base64url");
let storedClientSecret = hashedClientSecret;
const coverageRequested = process.argv.includes("--coverage");
const options = {
  inspectorPort: coverageRequested ? 0 : undefined,
  name: "cloud-agent-admin-check", modulesRoot: directory, modules: [{ type: "ESModule", path: bundle }], compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["CONVERSATIONS"],
  durableObjects: { Credentials: { className: "Credentials", useSQLite: true }, Assistant: { className: "Assistant", useSQLite: true } },
  bindings: { ALLOWED_CHANNEL_ID: "sample-channel", ALLOWED_CHAT_ID: "sample-group", CHANNEL_APP_ID: "sample-app", PUBLIC_ORIGIN: origin, PRODUCT_NAME: "Fixture Cloud Agent", SSO_ISSUER: issuer, SSO_CLIENT_ID: "fixture-client", SSO_CLIENT_SECRET: rawClientSecret, SUPER_ADMIN_EMAILS: JSON.stringify(Object.keys(admins)), SUPER_ADMIN_SUBJECTS: JSON.stringify(admins), SSO_LOGIN_URL: "https://auth.fixture.invalid/auth/login", SSO_SITE: "sample-site", TOKEN_WRAPPING_KEY: randomBytes(32).toString("base64"), PROBE_KEY_SHA256: digest(operator), DIAGNOSTIC_READS_ENABLED: "true" },
  outboundService: async request => {
    if (request.url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/oauth2/userinfo`, id_token_signing_alg_values_supported: ["EdDSA"], code_challenge_methods_supported: ["S256"] });
    if (request.url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (request.url === `${issuer}/oauth2/token`) {
      tokenCalls++; const body = new URLSearchParams(await request.text());
      const [clientId, clientSecret] = Buffer.from(request.headers.get("authorization").slice(6), "base64").toString().split(":");
      assert.equal(clientId, "fixture-client");
      if (createHash("sha256").update(clientSecret).digest("base64url") !== storedClientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
      assert.equal(body.get("redirect_uri"), `${origin}/auth/callback`); assert.match(body.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ id_token: jwt(), access_token: "fixture-sso-access", token_type: "Bearer" });
    }
    if (request.url === `${issuer}/oauth2/userinfo`) { userInfoCalls++; assert.equal(request.headers.get("authorization"), "Bearer fixture-sso-access"); return Response.json({ sub: overrides.userinfoSub || admins["admin-one@example.invalid"], email: "admin-one@example.invalid", email_verified: true }); }
    throw Error(`Unexpected network ${new URL(request.url).origin}`);
  }
};
const mf = new Miniflare(convertV4MiniflareOptions(options));
const send = (path, options = {}) => mf.dispatchFetch(`${origin}${path}`, { redirect: "manual", ...options });
const sessionCookie = r => r.headers.getSetCookie().find(value => value.startsWith("__Host-cloud_agent_session=")).split(";")[0];
const start = async () => {
  const r = await send("/auth/login"); assert.equal(r.status, 303, await r.clone().text());
  const login = new URL(r.headers.get("location")); assert.equal(login.searchParams.get("sitename"), "sample-site");
  const authorization = new URL(login.searchParams.get("callbackURL")); nonce = authorization.searchParams.get("nonce");
  assert.equal(authorization.origin, new URL(issuer).origin); assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/auth/callback`);
  return { browser: r.headers.get("set-cookie").split(";")[0], state: authorization.searchParams.get("state") };
};
const complete = attempt => send(`/auth/callback?${new URLSearchParams({ code: "fixture-code", state: attempt.state, iss: issuer })}`, { headers: { cookie: attempt.browser } });
const overview = async cookie => { const r = await send("/api/overview", { headers: { cookie } }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const post = (path, body, cookie, csrf, extra = {}) => send(path, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": csrf, ...extra }, body: JSON.stringify(body) });
const coverageFunctions = new Map();
let profiler, sendInspector, coverageUnavailable;
async function startCoverage() {
  if (!coverageRequested || coverageUnavailable) return;
  try {
    await send("/");
    const inspectorUrl = await mf.getInspectorURL();
    const targets = await (await fetch(new URL("/json/list", inspectorUrl.href.replace(/^ws:/, "http:")))).json();
    const target = targets.find(item => item.id.includes("cloud-agent-admin-check")) ?? targets[0];
    assert.ok(target?.webSocketDebuggerUrl, "workerd inspector target exists");
    profiler = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { profiler.addEventListener("open", resolve, { once: true }); profiler.addEventListener("error", reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    profiler.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(Error("workerd coverage unavailable: " + message.error.message));
      else resolve(message.result);
    });
    sendInspector = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); profiler.send(JSON.stringify({ id, method, params }));
    });
    await sendInspector("Profiler.enable");
    await sendInspector("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  } catch (error) { coverageUnavailable = error.message; profiler?.close(); profiler = undefined; }
}
async function collectCoverage() {
  if (!profiler || coverageUnavailable) return;
  try {
    const profile = await sendInspector("Profiler.takePreciseCoverage");
    const source = await readFile(bundle, "utf8");
    const start = source.indexOf("// workers/pi/admin.js"), end = source.indexOf("\n// ", start + 1);
    assert.ok(start >= 0 && end > start, "Admin source boundaries exist in bundle");
    const functions = profile.result.filter(script => script.url.endsWith("worker.js")).flatMap(script => script.functions).filter(fn => fn.ranges[0].startOffset >= start && fn.ranges[0].endOffset <= end);
    assert.ok(functions.length, "Actual admin functions appear in workerd coverage");
    for (const fn of functions) {
      const range = fn.ranges[0], key = range.startOffset + ":" + range.endOffset;
      const previous = coverageFunctions.get(key);
      coverageFunctions.set(key, { functionName: fn.functionName, startOffset: range.startOffset - start, endOffset: range.endOffset - start, count: (previous?.count || 0) + range.count });
    }
    await sendInspector("Profiler.stopPreciseCoverage");
  } catch (error) { coverageUnavailable = error.message; }
  finally { profiler?.close(); profiler = undefined; }
}
await startCoverage();
try {
  assert.equal((await mf.dispatchFetch("https://old.workers.dev/health")).status, 421);
  const landing = await send("/"); assert.equal(landing.status, 200); assert.match(await landing.text(), /Fixture Cloud Agent/);
  assert.equal((await send("/api/overview", { headers: { authorization: `Bearer ${operator}` } })).status, 401);
  assert.equal((await post("/api/accounts/start", { id: "owner", planUsageConfirmed: true }, "", "", { authorization: `Bearer ${operator}` })).status, 401);
  assert.equal((await send("/status", { headers: { authorization: `Bearer ${operator}` } })).status, 200);
  let attempt = await start();
  assert.equal((await complete({ ...attempt, browser: "__Host-cloud_agent_login=wrong" })).status, 400);
  const loggedIn = await complete(attempt); assert.equal(loggedIn.status, 303, await loggedIn.clone().text());
  const beforeReplay = tokenCalls; assert.equal((await complete(attempt)).status, 400); assert.equal(tokenCalls, beforeReplay);
  const adminCookie = sessionCookie(loggedIn), primaryAdmin = await overview(adminCookie);
  assert.equal(hashedClientSecret.length, 43); assert.notEqual(hashedClientSecret, rawClientSecret);
  storedClientSecret = rawClientSecret; const incorrectStoredSecret = await start(); const secretRejected = await complete(incorrectStoredSecret); assert.equal(secretRejected.status, 502); assert.equal((await secretRejected.json()).error, "sso_request_failed"); storedClientSecret = hashedClientSecret;
  assert.equal(primaryAdmin.principal.email, "admin-one@example.invalid"); assert.equal(primaryAdmin.principal.role, "super_admin"); assert.equal(primaryAdmin.defaultAccountId, "owner");
  assert.deepEqual(primaryAdmin.accountSelection, { mode: "fixed", defaultAccountId: "owner", poolAccountIds: [] }); assert.equal(primaryAdmin.accounts[0].identity, null); assert.equal(primaryAdmin.accounts[0].label, "owner");
  const html = await (await send("/", { headers: { cookie: adminCookie } })).text();
  assert.ok(!html.includes('name="label"')); assert.match(html, /ChatGPT 계정 ID로 자동 지정/);
  const uiScript = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1]; new Script(uiScript);
  const accountUi = {}; new Script(uiScript.slice(uiScript.indexOf("const esc="), uiScript.indexOf("async function api(")) + uiScript.slice(uiScript.indexOf("const tokens="), uiScript.indexOf("async function refresh("))).runInNewContext(accountUi);
  const legacyCard = accountUi.accountView({ id: "owner", label: "Legacy", expectedEmail: "configured@example.invalid" }, { defaultAccountId: "owner", accountSelection: { mode: "fixed", poolAccountIds: [] } }); assert.match(legacyCard, /검증 이메일: 제공되지 않음/); assert.match(legacyCard, /설정 이메일: configured@example.invalid/); assert.match(legacyCard, /정보 새로고침으로 확인하세요/);
  const metadataCard = accountUi.accountView({ id: "owner", label: "Account", identity: { source: "verified_id_token", email: "<b>verified@example.invalid</b>", accountId: "selected-account", planType: "plus", workspace: null, organizations: null }, usage: { source: "pi_committed_usage", input: 5, output: 3, totalTokens: 8, cacheRead: 0, cacheWrite: 0, reasoning: 1, quota: null } }, { defaultAccountId: "owner", accountSelection: { mode: "fixed", poolAccountIds: [] } }); assert.match(metadataCard, /&lt;b&gt;verified@example.invalid&lt;\/b&gt;/); assert.match(metadataCard, /워크스페이스: 제공되지 않음/); assert.match(metadataCard, /입력 5 · 출력 3 · 전체 8/); assert.ok(!metadataCard.includes("undefined") && !metadataCard.includes("requests"));
  const controls = [], nodes = new Map(), ui = { selectedRoot: "first", selectedThreadKey: "channel-fixture-key", workspace: { historyVersion: 0 }, safeText: value => value, renderHistory: value => { ui.$("thread-history").textContent = JSON.stringify(value); }, pendingControls: new Map(), crypto: { randomUUID }, settingsView() {}, $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: "" }); return nodes.get(id); } };
  let historyFails = true, finishHistory, historyStarted;
  ui.api = async (path, input) => { if (input) { assert.equal(input.threadKey, "channel-fixture-key"); controls.push(input.operationId); return { status: "done", message: "Applied", settings: {} }; } assert.equal(path, "/api/threads/history?root=first&threadKey=channel-fixture-key"); if (historyFails) throw Error("history_refresh_failed"); return { root: "first" }; };
  new Script(uiScript.slice(uiScript.indexOf("async function threadControl("), uiScript.indexOf("for(const action of ['model'"))).runInNewContext(ui);
  await assert.rejects(ui.threadControl("new"), /history_refresh_failed/); assert.equal(ui.pendingControls.size, 1);
  historyFails = false; await ui.threadControl("new"); assert.equal(controls[0], controls[1]); assert.equal(ui.pendingControls.size, 0);
  const started = new Promise(resolve => { historyStarted = resolve; });
  ui.api = async (path, input) => input ? { status: "done", message: "Applied", settings: {} } : new Promise(resolve => { finishHistory = resolve; historyStarted(); });
  nodes.get("thread-history").textContent = "second root history"; const pendingUi = ui.threadControl("reload"); await started; ui.selectedRoot = "second"; finishHistory({ root: "first" }); await pendingUi;
  assert.equal(nodes.get("thread-history").textContent, "second root history");
  assert.ok(!html.includes("fixture-sso-access") && !JSON.stringify(primaryAdmin).includes("fixture-sso-secret"));
  assert.equal((await post("/api/accounts/create", { expectedEmail: "a@example.invalid" }, adminCookie, "wrong")).status, 403);
  assert.equal((await post("/api/accounts/refresh", { id: "owner" }, adminCookie, "wrong")).status, 403);
  assert.equal((await post("/api/accounts/refresh", { id: "owner" }, "", "", { authorization: `Bearer ${operator}` })).status, 401);
  assert.equal((await post("/api/accounts/refresh", { id: "owner" }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await post("/api/accounts/create", { expectedEmail: "a@example.invalid" }, adminCookie, primaryAdmin.csrf, { origin: "https://evil.invalid" })).status, 403);
  const oversizedBody = new ReadableStream({ start(controller) { for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode(" ".repeat(100000))); controller.close(); } });
  const oversized = await send("/api/skills/validate", { method: "POST", headers: { cookie: adminCookie, origin, "content-type": "application/json", "x-csrf-token": primaryAdmin.csrf }, body: oversizedBody, duplex: "half" });
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error, "request_too_large");
  const staleCreate = await post("/api/accounts/create", { label: "Old custom name", expectedEmail: "old@example.invalid" }, adminCookie, primaryAdmin.csrf); assert.equal(staleCreate.status, 400); assert.equal((await staleCreate.json()).error, "invalid_fields");
  const create = await post("/api/accounts/create", { expectedEmail: "a@example.invalid" }, adminCookie, primaryAdmin.csrf); assert.equal(create.status, 200);
  const id = (await create.json()).id; assert.match(id, /^account-/); assert.equal((await overview(adminCookie)).accounts.find(row => row.id === id).label, id);
  const simultaneousAccounts = await Promise.all([post("/api/accounts/create", { expectedEmail: "second@example.invalid" }, adminCookie, primaryAdmin.csrf), post("/api/accounts/create", { expectedEmail: "third@example.invalid" }, adminCookie, primaryAdmin.csrf)]);
  assert.ok(simultaneousAccounts.every(r => r.status === 200)); assert.equal((await overview(adminCookie)).accounts.length, 4);
  const thirdId = (await simultaneousAccounts[1].json()).id;
  assert.equal((await post("/api/accounts/default", { id }, adminCookie, primaryAdmin.csrf)).status, 409);
  assert.equal((await post("/api/accounts/start", { id, planUsageConfirmed: false }, adminCookie, primaryAdmin.csrf)).status, 400);
  assert.equal((await post("/api/accounts/start", { id, planUsageConfirmed: true }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await post("/api/accounts/complete", { id, callbackUrl: "http://127.0.0.1:1455/auth/callback?code=fixture" }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await post("/api/accounts/start", { id: thirdId, planUsageConfirmed: true }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await post("/api/accounts/complete", { id: thirdId, callbackUrl: "http://127.0.0.1:1455/auth/callback?code=fixture" }, adminCookie, primaryAdmin.csrf)).status, 200);
  const selectedInfo = (await overview(adminCookie)).accounts.find(row => row.id === id); assert.equal(selectedInfo.identity.email, "verified@example.invalid"); assert.equal(selectedInfo.expectedEmail, "a@example.invalid"); assert.equal(selectedInfo.identity.planType, "plus"); assert.equal(selectedInfo.identity.workspace, null); assert.equal(selectedInfo.identity.organizations, null); assert.equal(selectedInfo.label, "fixture-chatgpt-account");
  for (const query of ["noAccountId=1", "identitySource=unverified"]) {
    assert.equal((await post("/api/accounts/complete", { id, callbackUrl: `http://127.0.0.1:1455/auth/callback?code=fixture&${query}` }, adminCookie, primaryAdmin.csrf)).status, 200);
    const fallback = (await overview(adminCookie)).accounts.find(row => row.id === id); assert.equal(fallback.label, id); assert.equal(fallback.id, id);
  }
  assert.equal((await post("/api/accounts/complete", { id, callbackUrl: "http://127.0.0.1:1455/auth/callback?code=fixture" }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await overview(adminCookie)).accounts.find(row => row.id === id).label, "fixture-chatgpt-account");
  const selection = { mode: "round_robin", defaultAccountId: "owner", poolAccountIds: [id, thirdId] };
  assert.equal((await post("/api/accounts/selection", { ...selection, poolAccountIds: [] }, adminCookie, primaryAdmin.csrf)).status, 409);
  assert.equal((await post("/api/accounts/selection", { ...selection, poolAccountIds: [id, id] }, adminCookie, primaryAdmin.csrf)).status, 400);
  assert.equal((await post("/api/accounts/selection", selection, adminCookie, "wrong")).status, 403);
  assert.equal((await post("/api/accounts/selection", selection, "", "", { authorization: `Bearer ${operator}` })).status, 401);
  assert.equal((await post("/api/accounts/selection", selection, adminCookie, primaryAdmin.csrf)).status, 200);
  const allocatorNamespace = await mf.getDurableObjectNamespace("Credentials"), allocator = allocatorNamespace.get(allocatorNamespace.idFromName("owner"));
  const allocate = async root => (await (await allocator.fetch(`https://fixture.invalid/?root=${root}&allocate=1`)).json()).assigned;
  assert.equal((await allocate("allocated-a")).accountId, id);
  assert.equal((await post("/api/accounts/selection", selection, adminCookie, primaryAdmin.csrf)).status, 200);
  const simultaneousRoots = await Promise.all([allocate("allocated-b"), allocate("allocated-c")]); assert.deepEqual(new Set(simultaneousRoots.map(row => row.accountId)), new Set([id, thirdId]));
  assert.equal((await allocate("allocated-a")).accountId, id); assert.equal((await allocate("allocated-d")).accountId, thirdId);
  const duplicateRoots = await Promise.all([allocate("allocated-duplicate"), allocate("allocated-duplicate")]); assert.ok(duplicateRoots.every(row => row.accountId === id)); assert.equal((await allocate("allocated-after-duplicate")).accountId, thirdId);
  const manualInput = { prompt: "Chosen account test", operationId: `manual-${randomUUID()}` };
  assert.equal((await post(`/ask?thread=manual-test&account=${id}`, manualInput, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await post(`/ask?thread=manual-test&account=${id}`, manualInput, adminCookie, primaryAdmin.csrf)).status, 200);
  const usageAccounts = (await overview(adminCookie)).accounts; assert.equal(usageAccounts.find(row => row.id === id).usage.totalTokens, 8); assert.equal(usageAccounts.find(row => row.id === id).usage.quota, null); assert.equal(usageAccounts.find(row => row.id === "owner").usage, null);
  assert.equal((await post(`/ask?thread=manual-test&account=account-${randomUUID()}`, manualInput, adminCookie, primaryAdmin.csrf)).status, 404);
  assert.equal((await post("/api/accounts/default", { id }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await overview(adminCookie)).accountSelection.mode, "fixed"); assert.equal((await allocate("allocated-after-fixed")).accountId, id);
  assert.equal((await post("/api/accounts/disconnect", { id }, adminCookie, primaryAdmin.csrf)).status, 400);
  assert.equal((await post("/api/accounts/disconnect", { id, confirmed: true }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await allocate("allocated-a")).accountId, id); assert.equal((await post(`/ask?thread=manual-test&account=${id}`, manualInput, adminCookie, primaryAdmin.csrf)).status, 409);
  assert.equal((await post("/api/accounts/selection", selection, adminCookie, primaryAdmin.csrf)).status, 409);
  assert.equal((await post("/api/accounts/default", { id: "owner" }, adminCookie, primaryAdmin.csrf)).status, 200);
  assert.equal((await allocate("allocated-owner")).accountId, "owner"); assert.equal((await allocate("allocated-a")).accountId, id);
  assert.equal((await post("/ask?thread=channel-injected", { prompt: "inject", operationId: "manual-test" }, adminCookie, primaryAdmin.csrf)).status, 400);
  const skill = { rawContent: "---\nname: test-skill\ndescription: A safe test skill\n---\nUse the listed reference.\n", resources: [{ path: "references/help.md", kind: "reference", content: "Fixture reference" }] };
  assert.equal((await post("/api/skills/validate", { ...skill, resources: [{ path: "references/../secret", kind: "reference", content: "bad" }] }, adminCookie, primaryAdmin.csrf)).status, 400);
  assert.equal((await post("/api/skills/validate", { ...skill, resources: [{ path: "assets/run.js", kind: "asset", content: "bad" }] }, adminCookie, primaryAdmin.csrf)).status, 400);
  assert.equal((await post("/api/skills/publish", skill, adminCookie, primaryAdmin.csrf)).status, 200);
  let state = await overview(adminCookie); assert.equal(state.skills[0].enabled, false); const revision = state.skills[0].revision;
  assert.equal((await post("/api/skills/toggle", { name: "test-skill", enabled: true }, adminCookie, primaryAdmin.csrf)).status, 200);
  state = await overview(adminCookie); const manifestVersion = state.manifestVersion; assert.equal(state.skills[0].revision, revision);
  const namespace = await mf.getDurableObjectNamespace("Credentials"), owner = namespace.get(namespace.idFromName("owner"));
  const fixture = await (await owner.fetch("https://fixture.invalid/?root=fixture-root")).json(); assert.equal(fixture.snapshot.manifest.version, manifestVersion); assert.equal(fixture.snapshot.manifest.skills[0].resources[0].content, "Fixture reference");
  assert.ok(!JSON.stringify(fixture.ciphertext).includes("admin-one@example.invalid")); assert.ok(Object.keys(fixture.ciphertext).length > 0);
  assert.equal((await send("/api/threads/history?root=unknown", { headers: { cookie: adminCookie } })).status, 404);
  assert.equal((await send("/api/threads/history?root=fixture-root", { headers: { cookie: adminCookie } })).status, 200);
  const control = { root: "fixture-root", operationId: `admin-${randomUUID()}`, action: "name", args: "Protected session" };
  assert.equal((await send("/api/threads/settings?root=unknown", { headers: { cookie: adminCookie } })).status, 404); assert.equal((await send("/api/threads/settings?root=fixture-root", { headers: { authorization: `Bearer ${operator}` } })).status, 401);
  assert.equal((await post("/api/threads/control", { ...control, root: "unknown" }, adminCookie, primaryAdmin.csrf)).status, 404); assert.equal((await post("/api/threads/control", control, adminCookie, "wrong")).status, 403); assert.equal((await post("/api/threads/control", control, "", "", { authorization: `Bearer ${operator}` })).status, 401);
  assert.equal((await post("/api/threads/control", { ...control, action: "compact" }, adminCookie, primaryAdmin.csrf)).status, 400); assert.equal((await post("/api/threads/control", { ...control, args: "busy" }, adminCookie, primaryAdmin.csrf)).status, 409);
  const appliedControl = await post("/api/threads/control", control, adminCookie, primaryAdmin.csrf); assert.equal(appliedControl.status, 200); assert.equal((await appliedControl.json()).executionCount, 1); assert.equal((await (await post("/api/threads/control", control, adminCookie, primaryAdmin.csrf)).json()).executionCount, 1);
  const settings = await (await send("/api/threads/settings?root=fixture-root", { headers: { cookie: adminCookie } })).json(); assert.equal(settings.selected.name, "Protected session"); assert.equal(settings.selected.accountId, "owner");
  const exported = await send("/api/threads/export?root=fixture-root", { headers: { cookie: adminCookie } }); assert.equal(exported.status, 200); assert.match(exported.headers.get("content-disposition"), /attachment; filename="thread-fixture-root.json"/);
  assert.equal((await send("/api/threads/export?root=fixture-root")).status, 401);
  assert.equal((await post("/api/skills/publish", { ...skill, rawContent: `${skill.rawContent}Revised body.` }, adminCookie, primaryAdmin.csrf)).status, 200);
  const revised = (await overview(adminCookie)).skills.find(s => s.name === "test-skill"); assert.equal(revised.enabled, false); assert.notEqual(revised.revision, revision);
  const toggles = await Promise.all([post("/api/skills/toggle", { name: "test-skill", enabled: false }, adminCookie, primaryAdmin.csrf), post("/api/skills/publish", { rawContent: "---\nname: second-skill\ndescription: Second safe skill\n---\nSecond fixture body" }, adminCookie, primaryAdmin.csrf)]); assert.ok(toggles.every(r => r.status === 200));
  state = await overview(adminCookie); assert.equal(state.skills.length, 2); assert.equal(state.skills.find(s => s.name === "test-skill").enabled, false);
  assert.equal((await send("/api/skills/source?name=test-skill", { headers: { cookie: adminCookie } })).status, 200);
  assert.equal((await (await owner.fetch(`https://fixture.invalid/?version=${manifestVersion}`)).json()).manifest.skills[0].version, revision);
  await collectCoverage();
  await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, DIAGNOSTIC_READS_ENABLED: "false" } }));
  await startCoverage();
  assert.equal((await send("/status", { headers: { authorization: `Bearer ${operator}` } })).status, 401);
  assert.equal((await overview(adminCookie)).skills.length, 2);
  for (let n = 0; n < 4; n++) {
    const rawContent = `---\nname: large-${n}\ndescription: Large boundary fixture\n---\n${"x".repeat(64000)}`;
    const resources = Array.from({ length: 3 }, (_, i) => ({ path: `references/large-${i}.md`, kind: "reference", content: "y".repeat(64000) }));
    assert.equal((await post("/api/skills/publish", { rawContent, resources }, adminCookie, primaryAdmin.csrf)).status, 200);
    const enable = await post("/api/skills/toggle", { name: `large-${n}`, enabled: true }, adminCookie, primaryAdmin.csrf);
    assert.equal(enable.status, n < 3 ? 200 : 409);
    if (n === 3) { assert.equal((await enable.json()).error, "skill_manifest_size_limit"); assert.equal((await overview(adminCookie)).skills.find(s => s.name === "large-3").enabled, false); }
  }
  assert.equal((await send(`/auth/callback?state=${"a".repeat(43)}&code=invalid`, { headers: { cookie: adminCookie } })).status, 400);
  assert.equal((await overview(adminCookie)).principal.email, "admin-one@example.invalid");
  for (const change of [{ nonce: "wrong" }, { aud: "wrong" }, { iss: "https://evil.invalid" }, { email_verified: false }, { email_verified: "true" }, { sub: "wrong" }, { email: "other@example.invalid" }]) {
    overrides = change; attempt = await start(); const rejected = await complete(attempt); assert.ok([400, 403].includes(rejected.status), await rejected.clone().text());
  }
  overrides = { email: "admin-two@example.invalid", sub: admins["admin-two@example.invalid"] }; attempt = await start(); const other = await complete(attempt); assert.equal(other.status, 303); assert.equal((await overview(sessionCookie(other))).principal.email, "admin-two@example.invalid");
  overrides = {}; missingEmail = true; attempt = await start(); assert.equal((await complete(attempt)).status, 303); assert.equal(userInfoCalls, 1);
  overrides = { userinfoSub: "other-sub" }; attempt = await start(); assert.equal((await complete(attempt)).status, 400);
  assert.equal((await post("/api/logout", {}, adminCookie, primaryAdmin.csrf)).status, 200); assert.equal((await send("/api/overview", { headers: { cookie: adminCookie } })).status, 401);
  console.log("PASS: real workerd canonical SSO, two pinned verified admins, one-use browser-bound PKCE, CSRF, no operator admin bypass, automatic verified account ID labels, account controls, immutable native skills, concurrent mutations, observed-thread boundaries.");
} finally {
  await collectCoverage();
  if (coverageRequested) {
    const functions = [...coverageFunctions.values()], called = functions.filter(fn => fn.count > 0).length;
    await mkdir("coverage", { recursive: true });
    await writeFile("coverage/admin-workerd.json", JSON.stringify({ source: "workers/pi/admin.js", mechanism: "workerd Profiler precise coverage", status: coverageUnavailable ? "unavailable" : "measured", error: coverageUnavailable ?? null, functions, called, total: functions.length, limitations: "Function counts for admin.js only. The Pi runtime and rendered browser script have behavioral checks but no coverage claim." }, null, 2));
    if (coverageUnavailable) { console.error(coverageUnavailable); process.exitCode = 2; }
    else console.log(`Measured admin workerd function coverage ${called}/${functions.length}. Pi runtime and browser script coverage are not claimed.`);
  }
  await mf.dispose(); await rm(directory, { recursive: true, force: true });
}
