import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, dependencies } from "./build.mjs";
import { subscriptionPage } from "./view.js";

const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = dependencies("miniflare");
const { JSDOM } = dependencies("jsdom");
const here = dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(join(tmpdir(), "subscription-native-check-"));
const issuer = "https://team.example.invalid", origin = "https://os.example.invalid", audience = "synthetic-access-application";
const email = "fixture@example.invalid", other = "other@example.invalid", model = "gpt-6.1-sol";
const oidcIssuer = "https://identity.example.invalid/oidc", oidcSubject = "fixture-oidc-admin";
const osToken = email + ":" + Buffer.alloc(32, 1).toString("base64");
const osOtherToken = email + ":" + Buffer.alloc(32, 2).toString("base64");
const sessionToken = suffix => email + ":" + Buffer.alloc(32, suffix).toString("base64");
const accessToken = "synthetic-siwc-access-never-log", refreshToken = "synthetic-siwc-refresh-never-log";
const accessKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const openaiKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessJwk = { ...accessKeys.publicKey.export({ format: "jwk" }), kid: "fixture-access", alg: "RS256", use: "sig" };
const openaiJwk = { ...openaiKeys.publicKey.export({ format: "jwk" }), kid: "fixture-openai", alg: "RS256", use: "sig" };
function jwt(keys, kid, claims, header = {}) {
  const input = [Buffer.from(JSON.stringify({ alg: "RS256", kid, ...header })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")].join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const accessJwt = (changes = {}, keys = accessKeys) => jwt(keys, accessJwk.kid, { iss: issuer, aud: audience, sub: "synthetic-admin", email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...changes });
let accountReads = 0, usageReads = 0, duringAccountRead = null;
let devicePolls = 0, deviceExchanges = 0, deviceSubject = "device-owner", deviceAccount = "device-account", deviceHtmlDenied = false, deviceStartDenied = false, deviceDeniedType = "text/html", deviceResponses = [], deviceJsonDenied = false;
const deviceClient = "app_EMoamEEZ73f0CkXaXp7hrann";
const deviceVerifier = "fixture-device-verifier-abcdefghijklmnopqrstuvwxyz";
let nonce, tokenCalls = 0, inferenceCalls = 0, refreshCalls = 0, claimsOverride = {}, refreshClaims = null, duringToken = null, outboundUrls = [];
const logs = [];
class CaptureLog extends Log { log(message) { logs.push(message); } }
await writeFile(join(work, "server.js"), `
import worker, { Credentials as BaseCredentials, CloudAgentInference } from ${JSON.stringify(join(here, "index.js"))};
import { WorkerEntrypoint } from 'cloudflare:workers';
export { CloudAgentInference };
export default worker;
const events = [];
let statusError = false;
export class Credentials extends BaseCredentials {
  constructor(ctx, env) { super(ctx, env); events.push('constructor'); }
  async configureAccount(input) { events.push('configureAccount'); return super.configureAccount(input); }
  async start(approval, intent) { events.push('start:' + approval + ':' + intent); return super.start(approval, intent); }
  async startCodex(intent) { events.push('startCodex:' + intent); return super.startCodex(intent); }
  async status() { events.push('status'); if(statusError)throw Error(${JSON.stringify(accessToken)});return super.status(); }
  async complete(callback) { events.push('complete'); return super.complete(callback); }
  async access(force) { events.push('access'); return super.access(force); }
  async codexAccess(force) { events.push('codexAccess'); return super.codexAccess(force); }
  async fetch(request) {
    if(new URL(request.url).pathname==='/fixture-disconnect') return Response.json(await this.disconnect());
    if(new URL(request.url).pathname==='/fixture-device-time') { const change=await request.json(); const pending=await this.open(await this.ctx.storage.get('codexImagePending')); await this.ctx.storage.put('codexImagePending',await this.seal({...pending,...change})); }
    if(new URL(request.url).pathname==='/fixture-put') { const input=await request.json();for(const [key,value] of Object.entries(input)) { if(value===null)await this.ctx.storage.delete(key);else await this.ctx.storage.put(key,value); } }
    return Response.json(Object.fromEntries(await this.ctx.storage.list()));
  }
}
export class Probe extends WorkerEntrypoint {
  events() { return events; }
  fail(value) { statusError=value; }
}
`);
await writeFile(join(work, "client.js"), `export default { async fetch(request, env) {
  const path=new URL(request.url).pathname;
  if(path==='/connections')return Response.json(await env.BRIDGE.subscriptionConnections());
  if(path==='/events')return Response.json(await env.PROBE.events());
  if(path==='/session-calls')return Response.json(await env.SESSION.count());
  if(path==='/fail'){await env.PROBE.fail((await request.json()).value);return Response.json({ok:true});}
  try { const result=await env.BRIDGE.infer(await request.json());return new Response(result.stream); }
  catch { return Response.json({error:'inference_denied'},{status:403}); }
}};`);
await writeFile(join(work, "session.js"), `
import { WorkerEntrypoint } from 'cloudflare:workers';
let calls = 0;
export class SubscriptionSetupSession extends WorkerEntrypoint {
  count() { return calls; }
  async verify(token) {
    calls++;
    if (token === ${JSON.stringify(sessionToken(6))}) throw Error(${JSON.stringify(osToken)});
    const principal = { issuer: ${JSON.stringify(oidcIssuer)}, subject: ${JSON.stringify(oidcSubject)}, email: ${JSON.stringify(email)} };
    if (token === ${JSON.stringify(osToken)}) return principal;
    if (token === ${JSON.stringify(osOtherToken)}) return { ...principal, email: ${JSON.stringify(other)} };
    if (token === ${JSON.stringify(sessionToken(3))}) return { ...principal, issuer: 'https://impostor.example.invalid/oidc' };
    if (token === ${JSON.stringify(sessionToken(4))}) return { ...principal, subject: 'impostor' };
    return null;
  }
}
export default { fetch() { return new Response(null, {status:404}); } };
`);
await bundle(join(work, "session.js"), join(work, "session.bundle.js"));
await bundle(join(work, "server.js"), join(work, "server.bundle.js"));
await bundle(join(work, "client.js"), join(work, "client.bundle.js"));
const productionBuild = await bundle(join(here, "index.js"), join(work, "production.bundle.js"));
assert.deepEqual(Object.values(productionBuild.metafile.outputs).find(value => value.exports.includes("default")).exports, ["CloudAgentInference", "Credentials", "default"]);
const bindings = {
  PUBLIC_ORIGIN: origin, CF_ACCESS_ISS: issuer, CF_ACCESS_AUD: audience, SUBSCRIPTION_ADMIN_EMAIL: email,
  TENANT_ID: "synthetic-subscription", PRODUCT_NAME: "Synthetic subscription", SUBSCRIPTION_INFERENCE_PROVIDER: "auto",
  INFERENCE_BRIDGE_PROVIDER: "auto", INFERENCE_BRIDGE_ACCOUNT_ID: "owner", INFERENCE_BRIDGE_MODEL: model,
  INFERENCE_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([email]), TOKEN_WRAPPING_KEY: randomBytes(32).toString("base64url"),
  TOKEN_WRAPPING_AAD: "synthetic-subscription/v1",
};
const oidcBindings = { ...bindings, SUBSCRIPTION_AUTH_MODE: "oidc", SUBSCRIPTION_ADMIN_ISSUER: oidcIssuer, SUBSCRIPTION_ADMIN_SUBJECT: oidcSubject };
delete oidcBindings.CF_ACCESS_ISS;
delete oidcBindings.CF_ACCESS_AUD;
const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const outboundService = async request => {
  outboundUrls.push(request.url);
  if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [accessJwk] });
  if (request.url === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [openaiJwk] });
  if (request.url === "https://chatgpt.com/backend-api/wham/accounts/check") {
    accountReads++; if(duringAccountRead) { const action=duringAccountRead; duringAccountRead=null; await action(); }
    return Response.json({accounts:[{id:deviceAccount,name:'Selected device workspace',structure:'workspace',plan_type:'plus'},{id:'other-account',name:'Other private workspace'}]});
  }
  if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
    usageReads++;
    return Response.json({account_id:deviceAccount,plan_type:'plus',rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:12,limit_window_seconds:18000,reset_at:1800000000},secondary_window:null}});
  }
  if (request.url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
    assert.deepEqual(await request.json(), { client_id: deviceClient });
    return deviceStartDenied ? new Response('<html>blocked</html>', {status:403, headers:{'content-type':'text/html'}}) : Response.json({device_auth_id:'fixture-device-private', user_code:'FIXTURE-CODE', interval:1});
  }
  if (request.url === "https://auth.openai.com/api/accounts/deviceauth/token") {
    devicePolls++;
    assert.deepEqual(await request.json(), {device_auth_id:'fixture-device-private',user_code:'FIXTURE-CODE'});
    if (deviceJsonDenied) return Response.json({error:'access_denied'},{status:403});
    if (deviceResponses.length) {
      const {status,body,headers}=deviceResponses.shift();
      return new Response(body,{status,headers});
    }
    return deviceHtmlDenied ? new Response(deviceDeniedType==='text/html'?'<!doctype html><html>blocked</html>':'Forbidden', {status:403,headers:{'content-type':deviceDeniedType}}) : Response.json({authorization_code:'fixture-device-code',code_verifier:deviceVerifier,code_challenge:createHash('sha256').update(deviceVerifier).digest('base64url')});
  }
  if (request.url === "https://auth.openai.com/oauth/token") {
    deviceExchanges++;
    const input = new URLSearchParams(await request.text());
    assert.equal(input.get('client_id'),deviceClient);
    const auth = {'chatgpt_plan_type':'plus','chatgpt_account_id':deviceAccount};
    const claims = {iss:'https://auth.openai.com',aud:deviceClient,sub:deviceSubject,email:'device@example.invalid',name:'Device subscriber',exp:Date.now()/1000+3600,'https://api.openai.com/auth':auth};
    return Response.json({access_token:jwt(openaiKeys,openaiJwk.kid,claims),refresh_token:'fixture-device-refresh',expires_in:3600,id_token:jwt(openaiKeys,openaiJwk.kid,claims)});
  }
  if (request.url === "https://auth.openai.com/api/accounts/oauth/token") {
    tokenCalls++;
    const input = new URLSearchParams(await request.text());
    assert.equal(input.get("client_id"), "synthetic-client");
    if (input.get("grant_type") === "refresh_token") {
      refreshCalls++;
      assert.equal(input.get("refresh_token"), refreshToken);
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "resource.invoke chatgpt.tokens.use.direct",
        ...(refreshClaims ? { id_token: jwt(openaiKeys, openaiJwk.kid, { iss: "https://auth.openai.com", aud: "synthetic-client", sub: "synthetic-openai-owner", email: other, email_verified: true, exp: Date.now() / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "synthetic-account" }, ...refreshClaims }) } : {}) });
    }
    assert.equal(input.get("grant_type"), "authorization_code");
    if (duringToken) { const run = duringToken; duringToken = null; await run(); }
    assert.equal(input.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
    assert.equal(input.get("resource"), "https://api.openai.com/v1");
    assert.match(input.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600,
      scope: "resource.invoke chatgpt.tokens.use.direct", id_token: jwt(openaiKeys, openaiJwk.kid, {
        iss: "https://auth.openai.com", aud: "synthetic-client", sub: "synthetic-openai-owner", email: other, name: "Verified subscriber",
        email_verified: true, nonce, exp: Date.now() / 1000 + 3600,
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "synthetic-account" }, ...claimsOverride,
      }),
    });
  }
  assert.ok(["https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/codex/responses"].includes(request.url), "outbound network is fixture-only");
  inferenceCalls++;
  if (request.url.startsWith("https://api.openai.com/")) assert.equal(request.headers.get("authorization"), `Bearer ${accessToken}`);
  else assert.equal(request.headers.get("chatgpt-account-id"), deviceAccount);
  const bytes = Buffer.from(await request.arrayBuffer());
  const input = JSON.parse(request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString());
  assert.equal(input.model, model);
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SIWC_READY", annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", model } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "SIWC_READY" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", model, output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]);
};
const common = { modulesRoot: work, modules: true, compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"] };
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false,
  log: new CaptureLog(LogLevel.DEBUG), handleStructuredLogs: value => logs.push(JSON.stringify(value)),
  workers: [
    { ...common, name: "subscription", routes: [origin + "/*"], scriptPath: join(work, "server.bundle.js"), bindings, durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, outboundService },
    { ...common, name: "private-client", scriptPath: join(work, "client.bundle.js"), serviceBindings: { PROBE: { name: "subscription", entrypoint: "Probe" }, BRIDGE: { name: "subscription", entrypoint: "CloudAgentInference" } } },
    { ...common, name: "os-session", scriptPath: join(work, "session.bundle.js") },
    { ...common, name: "oidc-subscription", scriptPath: join(work, "server.bundle.js"), bindings: oidcBindings, serviceBindings: { OS_SESSION: { name: "os-session", entrypoint: "SubscriptionSetupSession" } }, durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, outboundService },
    { ...common, name: "oidc-client", scriptPath: join(work, "client.bundle.js"), serviceBindings: { PROBE: { name: "oidc-subscription", entrypoint: "Probe" }, SESSION: { name: "os-session", entrypoint: "SubscriptionSetupSession" }, BRIDGE: { name: "oidc-subscription", entrypoint: "CloudAgentInference" } } },
    ...["SUBSCRIPTION_ADMIN_ISSUER", "SUBSCRIPTION_ADMIN_SUBJECT", "SUBSCRIPTION_ADMIN_EMAIL"].map((missing, i) => ({ ...common, name: "oidc-missing-pin-" + i, scriptPath: join(work, "production.bundle.js"), bindings: Object.fromEntries(Object.entries(oidcBindings).filter(([key]) => key !== missing)), serviceBindings: { OS_SESSION: { name: "os-session", entrypoint: "SubscriptionSetupSession" } }, durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, outboundService })),
    { ...common, name: "native-production", scriptPath: join(work, "production.bundle.js"), bindings, durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, outboundService },
  ],
}));
const headers = (changes = {}) => ({ "cf-access-jwt-assertion": accessJwt(), origin, "content-type": "application/json", ...changes });
const send = (path, value = {}, options = {}) => mf.dispatchFetch(origin + path, { method: "POST", headers: headers(), body: JSON.stringify(value), ...options });
const assertError = async (response, status, error) => {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
};
const privateClient = await mf.getWorker("private-client");
const events = async () => (await privateClient.fetch("https://fixture.invalid/events")).json();
const inspect = async () => {
  const namespace = await mf.getDurableObjectNamespace("Credentials", "subscription");
  return (await namespace.get(namespace.idFromName("owner")).fetch("https://fixture.invalid/fixture-state")).json();
};
const start = async (accountId) => {
  const response = await send("/gatekeeper/subscription/start", { planUsageConfirmed: true, ...(accountId && {accountId}) });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["authorizationUrl", "expiresIn", "manualCallbackRequired"]);
  const authorization = new URL(result.authorizationUrl);
  nonce = authorization.searchParams.get("nonce");
  assert.equal(authorization.origin, "https://auth.openai.com");
  assert.equal(authorization.pathname, "/api/accounts/authorize");
  assert.equal(authorization.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(authorization.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.ok(authorization.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
  return authorization;
};
const callback = authorization => `http://127.0.0.1:1455/auth/callback?${new URLSearchParams({ code: "synthetic-code-never-log", client_id: "synthetic-client", state: authorization.searchParams.get("state"), iss: "https://auth.openai.com" })}`;
const wire = changes => ({ version: 1, requestId: crypto.randomUUID(), userId: email, context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, options: { maxTokens: 16 }, ...changes });

try {
  const oidc = await mf.getWorker("oidc-subscription");
  const oidcClient = await mf.getWorker("oidc-client");
  const oidcEvents = async () => (await oidcClient.fetch("https://fixture.invalid/events")).json();
  const oidcSend = (token = osToken, input = {}, path = "status", extraHeaders = {}) => oidc.fetch(origin + "/gatekeeper/subscription/" + path, {
    method: "POST", headers: { origin, "content-type": "application/json", ...(token && { authorization: "Bearer " + token }), ...extraHeaders }, body: JSON.stringify(input),
  });
  const sessionCalls = async () => (await oidcClient.fetch("https://fixture.invalid/session-calls")).json();
  const publicShell = await oidc.fetch(origin + "/gatekeeper/subscription");
  assert.equal(publicShell.status, 200);
  assert.equal(await sessionCalls(), 0, "anonymous OIDC GET never reads an account session");
  const shell = await publicShell.text();
  const documentNonce = publicShell.headers.get("content-security-policy").match(/'nonce-([a-f0-9]{32})'/)[1];
  assert.ok(!/<form\b|<textarea\b|id="(?:setup-start|setup-complete|device-start|add-connection)"/.test(shell), 'anonymous OIDC GET must not expose setup forms');
  assert.ok(shell.includes('nonce="' + documentNonce + '"'));
  assert.ok(!shell.includes(email) && !shell.includes(oidcSubject) && !shell.includes(oidcIssuer) && !shell.includes(osToken));
  assert.equal(publicShell.headers.get("cache-control"), "no-store");
  const anonymousNonce = await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{"x-subscription-document-nonce":"a".repeat(32)}});
  assert.ok(!(await anonymousNonce.text()).includes('nonce="' + "a".repeat(32) + '"'), "anonymous callers cannot choose the bootstrap nonce");
  assert.equal(await sessionCalls(), 0);
  for (const token of ["invalid", sessionToken(5), sessionToken(6)]) await assertError(await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{authorization:"Bearer " + token,"x-subscription-document-nonce":"invalid"}}),401,"access_denied");
  for (const token of [osOtherToken, sessionToken(3), sessionToken(4)]) await assertError(await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{authorization:"Bearer " + token}}),403,"admin_denied");
  for (const badNonce of ["a".repeat(31), "A".repeat(32), 'a" onload="bad', "a".repeat(33)]) await assertError(await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{authorization:"Bearer " + osToken,"x-subscription-document-nonce":badNonce}}),400,"request_invalid");
  const beforeDocument = await sessionCalls();
  const authenticatedDocument = await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{authorization:"Bearer " + osToken,"x-subscription-document-nonce":documentNonce}});
  assert.equal(authenticatedDocument.status,200);
  assert.equal(await sessionCalls(),beforeDocument+1,"form HTML requires the private OS session check");
  const authenticatedPageHtml = await authenticatedDocument.text();
  assert.ok(authenticatedPageHtml.includes('id="setup-start" disabled') && authenticatedPageHtml.includes('id="setup-complete" disabled'));
  for (const id of ['add-connection','connection-select','device-start']) assert.ok(authenticatedPageHtml.includes('id="'+id+'"'),"authorized HTML retains named and dual-provider forms");
  assert.ok(authenticatedDocument.headers.get("content-security-policy").includes("'nonce-"+documentNonce+"'"));
  for(const match of authenticatedPageHtml.matchAll(/<(?:script|style) nonce="([^"]+)"/g)) assert.equal(match[1],documentNonce,"loaded markup uses the bootstrap CSP nonce");
  const directDocument = await oidc.fetch(origin + "/gatekeeper/subscription", {headers:{authorization:"Bearer " + osToken}});
  assert.equal(directDocument.status,200,"direct authenticated requests can receive a fresh document nonce");
  assert.ok((await directDocument.text()).includes('id="complete"'));
  assert.deepEqual(await oidcEvents(),[],"HTML authentication and nonce validation never access Credentials");
  for (const path of ["connections", "connections/create"]) await assertError(await oidcSend(null, {label:'Denied'}, path),401,"access_denied");
  for (const token of [null, "invalid", "x".repeat(300), sessionToken(5), sessionToken(6)]) await assertError(await oidcSend(token), 401, "access_denied");
  for (const token of [osOtherToken, sessionToken(3), sessionToken(4)]) await assertError(await oidcSend(token), 403, "admin_denied");
  await assertError(await oidcSend(null, {}, "status", { "cf-access-jwt-assertion": accessJwt(), "x-auth-email": email, "x-auth-subject": oidcSubject, "x-auth-issuer": oidcIssuer }), 401, "access_denied");
  await assertError(await oidcSend(null, { issuer: oidcIssuer, subject: oidcSubject, email }), 401, "access_denied");
  for (let i = 0; i < 3; i++) {
    const missingPin = await mf.getWorker("oidc-missing-pin-" + i);
    await assertError(await missingPin.fetch(origin + "/gatekeeper/subscription/status", { method: "POST", headers: { origin, "content-type": "application/json", authorization: "Bearer " + osToken }, body: "{}" }), 503, "configuration_invalid");
  }
  assert.deepEqual(await oidcEvents(), [], "OIDC missing sessions, each identity mismatch and spoofed claims denied before Credentials");
  const beforeStatus = await sessionCalls();
  assert.equal((await oidcSend()).status, 200);
  assert.equal(await sessionCalls(), beforeStatus + 1, "authenticated status checks the OS session");
  assert.deepEqual(await oidcEvents(), ["constructor", "status"]);
  const oidcStart = await oidcSend(osToken, { planUsageConfirmed: true }, "start");
  assert.equal(oidcStart.status, 200);
  assert.equal(new URL((await oidcStart.json()).authorizationUrl).searchParams.get("client_id"), "dynamic_agent_client");

  const production = await mf.getWorker("native-production");
  const productionPage = await production.fetch(origin + "/gatekeeper/subscription", { method: "GET", headers: headers() });
  assert.equal(productionPage.status, 200, "unmodified production artifact runs under workerd: " + await productionPage.text());
  const freshProduction = await production.fetch(origin + "/gatekeeper/subscription/start", { method: "POST", headers: headers(), body: JSON.stringify({ planUsageConfirmed: true }) });
  assert.equal(freshProduction.status, 200);
  assert.equal(new URL((await freshProduction.json()).authorizationUrl).searchParams.get("client_id"), "dynamic_agent_client", "unmodified production starts a new namespace grant");
  for (const path of ["/gatekeeper/subscription/connections", "/gatekeeper/subscription/connections/create", "/gatekeeper/subscription/device/start", "/gatekeeper/subscription/device/check", "/gatekeeper/subscription/select", "/gatekeeper/subscription/account-info", "/gatekeeper/subscription", "/gatekeeper/subscription/status", "/gatekeeper/subscription/start", "/gatekeeper/subscription/complete", "/gatekeeper/subscription/refresh"]) {
    await assertError(await send(path, {}, { headers: { origin, "content-type": "application/json" } }), 401, "access_denied");
  }
  for (const token of ["invalid", accessJwt({ iss: "https://wrong.example.invalid" }), accessJwt({ aud: "wrong" }), accessJwt({ exp: 1 }), accessJwt({ nbf: Math.floor(Date.now() / 1000) + 3600 }), accessJwt({}, openaiKeys), accessJwt({ exp: undefined }), accessJwt({ sub: undefined }), accessJwt({ iat: "invalid" }), accessJwt({ iat: Math.floor(Date.now() / 1000) + 3600 })]) {
    await assertError(await send("/gatekeeper/subscription/status", {}, { headers: headers({ "cf-access-jwt-assertion": token }) }), 401, "access_denied");
  }
  await assertError(await send("/gatekeeper/subscription/start", {}, { headers: headers({ "cf-access-jwt-assertion": accessJwt({ email: other }) }) }), 403, "admin_denied");
  for (const requestOrigin of ["https://cross.example.invalid", "null", ""]) await assertError(await send("/gatekeeper/subscription/start", {}, { headers: headers({ origin: requestOrigin }) }), 403, "origin_denied");
  const missingOrigin = headers(); delete missingOrigin.origin;
  await assertError(await send("/gatekeeper/subscription/complete", {}, { headers: missingOrigin }), 403, "origin_denied");
  await assertError(await send("/gatekeeper/subscription/start", {}, { headers: headers({ "content-type": "text/plain" }) }), 415, "json_required");
  await assertError(await send("/gatekeeper/subscription/start", {}, { body: "x".repeat(20481) }), 413, "body_too_large");
  await assertError(await send("/gatekeeper/subscription/start", {}, { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(15000)); controller.enqueue(new Uint8Array(10000)); controller.close(); } }), duplex: "half" }), 413, "body_too_large");
  await assertError(await send("/gatekeeper/subscription/start", {}, { body: '{"email":"' + "한".repeat(7000) + '"}' }), 413, "body_too_large");
  await assertError(await send("/gatekeeper/subscription/start", {}, { body: new Uint8Array([255, 254]) }), 400, "body_invalid");
  for (const bad of [null, [], { accountId: "arbitrary" }, { planUsageConfirmed: false }, { email, planUsageConfirmed: true }, { planUsageConfirmed: true, replaceAccount: true }, { planUsageConfirmed: true, accountId: "arbitrary" }]) {
    await assertError(await send("/gatekeeper/subscription/start", bad), 400, bad === null || Array.isArray(bad) ? "body_invalid" : "start_input_invalid");
  }
  await assertError(await send("/gatekeeper/subscription/status", { accountId: "arbitrary" }), 400, "body_invalid");
  await assertError(await send("/gatekeeper/subscription/refresh", { email }), 400, "body_invalid");
  await assertError(await send("/gatekeeper/subscription/status?callbackUrl=synthetic"), 400, "request_invalid");
  await assertError(await send("/infer"), 404, "not_found");
  await assertError(await send("/gatekeeper/subscription/status", {}, { method: "GET", body: undefined }), 405, "method_not_allowed");
  assert.deepEqual(await events(), [], "all unauthorized/invalid requests rejected before any DO call");
  assert.equal(tokenCalls, 0);

  const page = await mf.dispatchFetch(origin + "/gatekeeper/subscription", { headers: headers() });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('lang="ko"'));
  assert.ok(page.headers.get("content-security-policy").includes("script-src 'nonce-"));
  assert.ok(!html.includes("localStorage") && !html.includes("sessionStorage"));
  let response = await send("/gatekeeper/subscription/status");
  const unavailableUsage = { available: false, reason: "provider_not_supplied" };
  assert.deepEqual(await response.json(), { connected: false, identityVerified: false, loginPending: false, planUsageConfirmed: false, siwcInferenceReady: false, identity: null, identityRefreshStatus: null, provider: "siwc", inferenceReady: false, codexInferenceReady: false, device: null, deviceFailed: false, usage: unavailableUsage });
  assert.ok(!html.includes('id="email"') && !html.includes('고정됩니다'));
  assert.ok(html.includes('https://chatgpt.com/settings/usage'));
  const notReady = await privateClient.fetch("https://fixture.invalid/infer", { method: "POST", body: JSON.stringify(wire()) });
  assert.equal(notReady.status, 403);
  assert.equal(inferenceCalls, 0);

  const namespace = await mf.getDurableObjectNamespace("Credentials", "subscription");
  const owner = namespace.get(namespace.idFromName("owner"));
  const put = value => owner.fetch("https://fixture.invalid/fixture-put", { method: "POST", body: JSON.stringify(value) });
  const stalePolicy = { expectedEmailHash: createHash("sha256").update(email).digest("hex"), label: "Previous unverified selection" };
  await put({ identityPolicy: stalePolicy, nativeUsageTotals: { source: "pi_committed_usage", totalTokens: 12345 } });
  let authorization = await start();
  assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
  const firstHost = authorization.searchParams.get("ext_agent_host_id");
  const pending = await inspect();
  assert.ok(pending.pending.ciphertext);
  assert.equal(pending.conversationTenant, bindings.TENANT_ID);
  assert.deepEqual(pending.identityPolicy, stalePolicy, "unverified pre-login email policy is neither enforced nor overwritten");
  assert.ok(!JSON.stringify(pending).includes(nonce));
  await assertError(await send("/gatekeeper/subscription/start", { email: other, planUsageConfirmed: true }), 400, "start_input_invalid");
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization).replace("state=", "state=wrong") }), 400, "callback_state_mismatch");
  assert.equal(tokenCalls, 0);
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, "oauth_attempt_expired");
  claimsOverride = { email: "invalid email" };
  authorization = await start();
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, "selected_email_mismatch");
  claimsOverride = {};
  authorization = await start();
  response = await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) });
  assert.equal(response.status, 200);
  const ready = await response.json();
  assert.deepEqual(ready, { connected: true, identityVerified: true, loginPending: false, planUsageConfirmed: true, siwcInferenceReady: true, identity: { name: "Verified subscriber", email: other, planType: "pro", workspaceName: null, organizationNames: null, verifiedAt: ready.identity.verifiedAt }, identityRefreshStatus: null, provider: "siwc", inferenceReady: true, codexInferenceReady: false, device: null, deviceFailed: false, usage: unavailableUsage });
  assert.ok(Number.isFinite(Date.parse(ready.identity.verifiedAt)));
  assert.notEqual(ready.identity.email, email, "OpenAI account is independent of the OS administrator");
  const stored = await inspect();
  assert.ok(stored.credential.ciphertext && stored.identity.ciphertext);
  assert.equal(stored.pending, undefined);
  for (const secret of [accessToken, refreshToken, email, other, "Verified subscriber", "synthetic-code-never-log", nonce]) assert.ok(!JSON.stringify(stored).includes(secret), "no unencrypted grant/callback/identity in DO state");
  assert.equal(stored.registration.clientId, "synthetic-client");
  assert.equal(stored.registration.identitySelection, "oauth");
  assert.deepEqual(stored.identityPolicy, stalePolicy);
  const preserved = async () => {
    const current = await inspect();
    for (const key of ["credential", "registration", "identity"]) assert.deepEqual(current[key], stored[key], "failed reconnect preserves " + key);
  };
  for (const changes of [{ sub: "wrong-subject" }, { "https://api.openai.com/auth": { chatgpt_account_id: "wrong-workspace" } }]) {
    claimsOverride = changes;
    authorization = await start();
    await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, changes.sub ? "selected_user_mismatch" : "selected_workspace_mismatch");
    await preserved();
  }
  claimsOverride = {};
  authorization = await start();
  const beforeChanged = tokenCalls;
  await put({ registration: { ...stored.registration, identitySelection: "legacy" } });
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, "account_registration_changed");
  assert.equal(tokenCalls, beforeChanged, "stale snapshot rejected before token exchange");
  await put({ registration: stored.registration });
  await assertError(await send("/gatekeeper/subscription/start", { email: other, planUsageConfirmed: true }), 400, "start_input_invalid");
  authorization = await start();
  assert.equal(authorization.searchParams.get("client_id"), "synthetic-client");
  assert.equal(authorization.searchParams.get("ext_agent_host_id"), firstHost);
  assert.equal((await (await send("/gatekeeper/subscription/status")).json()).siwcInferenceReady, true, "repeat start keeps existing grant ready");
  assert.ok(!(await events()).includes("startCodex"));
  assert.ok((await events()).includes("start:true:connect"));
  assert.ok(!(await events()).includes("configureAccount"));

  const beforeDenied = (await events()).length;
  assert.equal((await privateClient.fetch("https://fixture.invalid/infer", { method: "POST", body: JSON.stringify(wire({ userId: other })) })).status, 403);
  assert.equal((await events()).length, beforeDenied, "private binding rejects wrong user before credentials");
  response = await privateClient.fetch("https://fixture.invalid/infer", { method: "POST", body: JSON.stringify(wire()) });
  const inference = await response.text();
  assert.equal(response.status, 200);
  assert.ok(inference.includes("SIWC_READY") && inference.includes('"type":"done"'));
  assert.equal(inferenceCalls, 1);
  assert.ok((await events()).includes("access"));
  assert.ok(!(await events()).includes("codexAccess"));
  for (const secret of [accessToken, refreshToken, callback(authorization), nonce, email]) assert.ok(!inference.includes(secret));
  await privateClient.fetch("https://fixture.invalid/fail", { method: "POST", body: JSON.stringify({ value: true }) });
  await assertError(await send("/gatekeeper/subscription/status"), 400, "oauth_failed");
  await privateClient.fetch("https://fixture.invalid/fail", { method: "POST", body: JSON.stringify({ value: false }) });

  response = await send("/gatekeeper/subscription/refresh");
  const noMetadata = await response.json();
  assert.equal(response.status, 200);
  assert.equal(noMetadata.identityRefreshStatus, "not_returned");
  assert.deepEqual(noMetadata.identity, ready.identity);
  assert.deepEqual(noMetadata.usage, unavailableUsage, "Pi ledger is not a subscription usage estimate");
  assert.equal(refreshCalls, 1);
  refreshClaims = { email: "renamed@example.invalid", name: "New verified name", "https://api.openai.com/auth": { chatgpt_plan_type: "business", chatgpt_account_id: "synthetic-account", workspace: { id: "workspace", name: "Workspace label" }, organizations: [{ id: "org", name: "Organization label" }] } };
  const updated = await (await send("/gatekeeper/subscription/refresh")).json();
  assert.equal(updated.identityRefreshStatus, "updated");
  assert.equal(updated.identity.email, "renamed@example.invalid", "email is refreshed metadata, not an account key");
  assert.equal(updated.identity.name, "New verified name");
  assert.equal(updated.identity.planType, "business");
  assert.equal(updated.identity.workspaceName, "Workspace label");
  assert.deepEqual(updated.identity.organizationNames, ["Organization label"]);
  refreshClaims = { "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" }, name: undefined };
  const missing = await (await send("/gatekeeper/subscription/refresh")).json();
  assert.equal(missing.identity.planType, null);
  assert.equal(missing.identity.workspaceName, null);
  assert.equal(missing.identity.organizationNames, null);
  assert.equal(missing.identity.name, null);
  refreshClaims = null;

  const deviceTime = change => owner.fetch("https://fixture.invalid/fixture-device-time", {method:'POST',body:JSON.stringify(change)});
  const activeBeforeDevice = await inspect();
  const deviceStart = await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true});
  assert.equal(deviceStart.status,200,await deviceStart.clone().text());
  const deviceAttempt = await deviceStart.json();
  assert.deepEqual(Object.keys(deviceAttempt).sort(),['expiresAt','nextCheckAt','userCode','verificationUrl']);
  assert.equal(deviceAttempt.verificationUrl,'https://auth.openai.com/codex/device');
  assert.equal(deviceAttempt.userCode,'FIXTURE-CODE');
  assert.equal((await inspect()).subscriptionProvider,'siwc','start does not select pending device grant');
  let deviceStatus = await (await send('/gatekeeper/subscription/status')).json();
  assert.equal(deviceStatus.device.userCode,'FIXTURE-CODE','reload can recover safe device information');
  assert.ok(!JSON.stringify(deviceStatus).includes('fixture-device-private'));
  await send('/gatekeeper/subscription/device/check');
  assert.equal(devicePolls,0,'server polling interval prevents early upstream request');
  deviceResponses=[
    {status:403,body:null}, {status:404,body:null},
    {status:403,body:'',headers:{'content-type':'application/json'}},
    {status:404,body:' \n\t',headers:{'content-type':'application/json'}},
    {status:403,body:' \n\t',headers:{'content-type':'text/plain'}},
    {status:403,body:JSON.stringify({error:'authorization_pending',message:'Waiting for approval',interval:1}),headers:{'content-type':'application/json'}},
    {status:404,body:JSON.stringify({status:'waiting',interval:1}),headers:{'content-type':'application/json'}},
    {status:403,body:JSON.stringify({error:null}),headers:{'content-type':'application/json'}},
    {status:404,body:JSON.stringify({error:{message:'Waiting for approval',details:{retry:true}}}),headers:{'content-type':'application/json'}},
    {status:403,body:JSON.stringify({error:'device_authorization_not_ready'}),headers:{'content-type':'text/plain'}},
    {status:404,body:JSON.stringify({error:{code:'authorization_pending',type:'device_authorization'}}),headers:{'content-type':'application/json'}},
  ];
  while(deviceResponses.length) { await deviceTime({nextAt:Date.now()-1}); const pendingResponse=await send('/gatekeeper/subscription/device/check'); assert.equal(pendingResponse.status,200,await pendingResponse.clone().text()); assert.equal((await pendingResponse.json()).device.userCode,'FIXTURE-CODE'); assert.equal((await inspect()).subscriptionProvider,'siwc','empty or pending-object response never activates'); }
  await deviceTime({nextAt:Date.now()-1});
  let deviceComplete = await send('/gatekeeper/subscription/device/check');
  assert.equal(deviceComplete.status,200,await deviceComplete.clone().text());
  deviceStatus = await deviceComplete.json();
  assert.equal(deviceStatus.provider,'codex'); assert.equal(deviceStatus.inferenceReady,true);
  assert.equal(deviceStatus.identity.email,'device@example.invalid'); assert.equal(deviceStatus.device,null);
  assert.equal(deviceStatus.siwcInferenceReady,true,'SIWC grant stays ready');
  const afterDevice = await inspect();
  assert.equal(afterDevice.subscriptionProvider,'codex');
  assert.deepEqual(afterDevice.credential,activeBeforeDevice.credential,'device leaves SIWC grant untouched');
  for(const secret of ['fixture-device-private','fixture-device-refresh','device@example.invalid']) assert.ok(!JSON.stringify(afterDevice).includes(secret),'device pending/profile/metadata encrypted');
  const deviceInference = await privateClient.fetch('https://fixture.invalid/infer',{method:'POST',body:JSON.stringify(wire())});
  assert.equal(deviceInference.status,200);
  const deviceInferenceText = await deviceInference.text();
  assert.ok(deviceInferenceText.includes('\"type\":\"done\"'), 'device inference completes: ' + deviceInferenceText + ' diagnostics: ' + logs.slice(-2).join(' '));
  assert.equal(outboundUrls.at(-1),'https://chatgpt.com/backend-api/codex/responses','auto bridge uses selected Codex transport');
  const accountInfo = await send('/gatekeeper/subscription/account-info');
  assert.equal(accountInfo.status,200,await accountInfo.clone().text());
  const projectedInfo = await accountInfo.json();
  assert.equal(projectedInfo.account.workspaceName,'Selected device workspace');
  assert.equal(projectedInfo.usage.primaryWindow.usedPercent,12);
  for(const forbidden of ['other-account','Other private workspace',deviceAccount,'fixture-device-refresh']) assert.ok(!JSON.stringify(projectedInfo).includes(forbidden));
  await send('/gatekeeper/subscription/account-info'); assert.equal(accountReads,1); assert.equal(usageReads,1,'account snapshot cache prevents repeat network reads');
  assert.ok((await inspect()).subscriptionAccountInfo.ciphertext);
  await put({subscriptionAccountInfo:null});
  let releaseAccount, accountReadStarted;
  const startedAccount = new Promise(resolve=>accountReadStarted=resolve);
  const waitAccount = new Promise(resolve=>releaseAccount=resolve);
  duringAccountRead=async()=>{accountReadStarted(); await waitAccount;};
  const staleInfo=send('/gatekeeper/subscription/account-info');
  await startedAccount;
  let selected = await send('/gatekeeper/subscription/select',{provider:'siwc'});
  releaseAccount();
  await assertError(await staleInfo,400,'account_selection_changed'); assert.equal(selected.status,200);
  assert.equal((await selected.json()).provider,'siwc');
  assert.equal((await (await send('/gatekeeper/subscription/account-info')).json()).usage.reason,'provider_not_supplied','SIWC does not expose stale Codex usage');
  await (await privateClient.fetch('https://fixture.invalid/infer',{method:'POST',body:JSON.stringify(wire())})).text();
  assert.equal(outboundUrls.at(-1),'https://api.openai.com/v1/responses','explicit choice routes SIWC without reauthentication');
  deviceSubject='other-device-owner';
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_identity_mismatch');
  assert.equal((await inspect()).subscriptionProvider,'siwc');
  assert.deepEqual((await inspect()).codexImageProfile,afterDevice.codexImageProfile,'wrong identity preserves existing device grant');
  deviceSubject='device-owner'; deviceHtmlDenied=true;
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_remote_denied');
  const deniedPolls=devicePolls;
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_attempt_failed_restart_login');
  assert.equal(devicePolls,deniedPolls,'HTML denial is not polled or retried');
  assert.equal((await inspect()).subscriptionProvider,'siwc');
  deviceDeniedType='text/plain';
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_remote_denied');
  const plainDeniedPolls=devicePolls;
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_attempt_failed_restart_login');
  assert.equal(devicePolls,plainDeniedPolls,'plaintext access denial is terminal');
  deviceHtmlDenied=false; deviceDeniedType='text/html';
  deviceJsonDenied=true;
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_remote_denied');
  const jsonDeniedPolls=devicePolls;
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_attempt_failed_restart_login');
  assert.equal(devicePolls,jsonDeniedPolls,'explicit JSON access denial is terminal'); deviceJsonDenied=false;
  for(const rejected of [
    {status:404,body:'Forbidden',headers:{'content-type':'text/plain'},error:'codex_image_remote_denied'},
    {status:403,body:' Access denied ',error:'codex_image_remote_denied'},
    {status:404,body:'<!doctype html><html>blocked</html>',error:'codex_image_remote_denied'},
    {status:403,body:'<html>blocked</html>',headers:{'content-type':'application/json'},error:'codex_image_remote_denied'},
    {status:403,body:JSON.stringify({error:'permission_denied'}),error:'codex_image_remote_denied'},
    {status:404,body:JSON.stringify({error:{code:'access_denied'}}),error:'codex_image_remote_denied'},
    {status:403,body:JSON.stringify({error:{type:'forbidden',message:'Blocked'}}),error:'codex_image_remote_denied'},
    {status:403,body:'{invalid',headers:{'content-type':'application/json'},error:'codex_image_oauth_response_invalid'},
    {status:403,body:'[]',headers:{'content-type':'application/json'},error:'codex_image_oauth_response_invalid'},
    {status:404,body:'null',headers:{'content-type':'application/json'},error:'codex_image_oauth_response_invalid'},
    {status:403,body:'Not ready yet',headers:{'content-type':'text/plain'},error:'codex_image_oauth_response_invalid'},
    {status:403,body:new Uint8Array([0xff]),headers:{'content-type':'application/json'},error:'codex_image_oauth_response_invalid'},
    {status:403,body:'{}',headers:{'content-type':'application/json','cf-mitigated':'challenge'},error:'codex_image_remote_denied'},
  ]) {
    deviceResponses=[rejected];
    await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
    await assertError(await send('/gatekeeper/subscription/device/check'),400,rejected.error);
    const rejectedPolls=devicePolls;
    await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_attempt_failed_restart_login');
    assert.equal(devicePolls,rejectedPolls,'invalid pending response is terminal without repeat');
    assert.equal((await inspect()).subscriptionProvider,'siwc','invalid pending response preserves active grant');
  }
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({expiresAt:Date.now()-1});
  await assertError(await send('/gatekeeper/subscription/device/check'),400,'codex_image_attempt_expired');
  deviceStartDenied=true;
  await assertError(await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}),400,'codex_image_oauth_http_403');
  assert.equal((await inspect()).subscriptionProvider,'siwc','failed device start never affects active connection'); deviceStartDenied=false;
  await assertError(await send('/gatekeeper/subscription/select',{provider:'arbitrary'}),400,'body_invalid');
  const beforeReconnect = await inspect();
  authorization=await start();
  const siwcReconnect=await send('/gatekeeper/subscription/complete',{callbackUrl:callback(authorization)});
  assert.equal(siwcReconnect.status,200,await siwcReconnect.clone().text());
  assert.equal((await inspect()).subscriptionProvider,'siwc');
  assert.deepEqual((await inspect()).codexImageProfile,beforeReconnect.codexImageProfile,'SIWC reauth preserves Codex slot');
  await put({credential:null});
  await assertError(await send('/gatekeeper/subscription/select',{provider:'siwc'}),400,'subscription_connection_unavailable');
  const selectedUnavailable=await (await send('/gatekeeper/subscription/status')).json();
  assert.equal(selectedUnavailable.provider,'siwc'); assert.equal(selectedUnavailable.inferenceReady,false,'selected unavailable SIWC never falls back to Codex');
  await put({credential:(await inspect()).credential ?? beforeReconnect.credential});
  // A fresh Codex-first setup must not become a SIWC registration or constrain its client/account fields.
  await put({credential:null,registration:null,identity:null,pending:null,codexImageProfile:null,codexRegistration:null,codexImagePending:null,subscriptionProvider:null});
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  assert.equal((await send('/gatekeeper/subscription/device/check')).status,200);
  assert.equal((await inspect()).subscriptionProvider,'codex');
  claimsOverride={'https://api.openai.com/auth':{chatgpt_plan_type:'pro'}};
  authorization=await start();
  assert.equal(authorization.searchParams.get('client_id'),'dynamic_agent_client');
  const freshSiwc=await send('/gatekeeper/subscription/complete',{callbackUrl:callback(authorization)});
  assert.equal(freshSiwc.status,200,await freshSiwc.clone().text());
  assert.equal((await freshSiwc.json()).provider,'siwc');
  assert.equal((await inspect()).registration.accountHash,null,'SIWC does not require Codex account ID');
  assert.equal((await send('/gatekeeper/subscription/select',{provider:'codex'})).status,200,'independent Codex pin remains valid after SIWC-first registration');
  const disconnected = await owner.fetch('https://fixture.invalid/fixture-disconnect');
  assert.equal(disconnected.status,200);
  const disconnectedStatus=await disconnected.json();
  assert.equal(disconnectedStatus.provider,'codex'); assert.equal(disconnectedStatus.inferenceReady,false); assert.equal(disconnectedStatus.subjectFingerprint,null,'selected missing Codex identity has no fingerprint');
  assert.equal((await (await send('/gatekeeper/subscription/status')).json()).provider,'codex','status remains available after disconnect');
  await send('/gatekeeper/subscription/device/start',{planUsageConfirmed:true}); await deviceTime({nextAt:Date.now()-1});
  const reconnectedDevice=await send('/gatekeeper/subscription/device/check'); assert.equal(reconnectedDevice.status,200); assert.equal((await reconnectedDevice.json()).inferenceReady,true,'same-account reconnect works after disconnect');
  claimsOverride={};
  const readsBeforeNamed = {account:accountReads,usage:usageReads};
  const excludedId = 'account-00000000-0000-0000-0000-000000000001';
  const unknownId = 'account-00000000-0000-0000-0000-000000000002';
  const fixedSelection = {mode:'fixed',defaultAccountId:'owner',poolAccountIds:[]};
  await put({adminAccounts:[{id:'owner',label:'owner',createdAt:null},{id:excludedId,label:'Other inventory account'}], accountSelection:fixedSelection, defaultAccountId:'owner'});
  const create = async label => {
    const response=await send('/gatekeeper/subscription/connections/create',{label});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  for (const label of ['', 'x'.repeat(129), '한'.repeat(43), 'bad\nlabel']) await assertError(await send('/gatekeeper/subscription/connections/create',{label}),400,'subscription_label_invalid');
  await assertError(await send('/gatekeeper/subscription/connections/create',{label:'Named',email}),400,'subscription_label_invalid');
  const createdA=await create('Connection A'), connectionA=createdA.id;
  const createdB=await create('Connection B'), connectionB=createdB.id;
  assert.match(connectionA,/^account-/);assert.notEqual(connectionA,connectionB);
  assert.deepEqual(createdB.connections.map(row=>row.id),['owner',connectionA,connectionB],'unrelated inventory accounts do not enter the subscription catalog');
  assert.deepEqual((await inspect()).accountSelection,fixedSelection);assert.equal((await inspect()).defaultAccountId,'owner');
  const catalogRows=(await inspect()).adminAccounts;
  assert.equal(catalogRows.find(row=>row.id===connectionA).subscriptionSetup,true);
  assert.ok(!Object.hasOwn(catalogRows.find(row=>row.id===connectionA),'expectedEmail'),'named setup creates no email policy');
  const beforeUnknownEvents=(await events()).length, beforeUnknownOutbound=outboundUrls.length;
  for (const accountId of [unknownId,excludedId]) {
    await assertError(await send('/gatekeeper/subscription/status',{accountId}),400,'subscription_account_not_found');
    await assertError(await send('/gatekeeper/subscription/start',{accountId,planUsageConfirmed:true}),400,'subscription_account_not_found');
    const denied=await privateClient.fetch('https://fixture.invalid/infer',{method:'POST',body:JSON.stringify(wire({subscriptionAccountId:accountId}))});
    assert.equal(denied.status,403);
  }
  assert.equal((await events()).length,beforeUnknownEvents,'unknown selectors never construct or inspect a target object');
  assert.equal(outboundUrls.length,beforeUnknownOutbound,'unknown selectors never make outbound calls');
  const targetObject=id=>namespace.get(namespace.idFromName(id));
  const targetState=async id=>(await targetObject(id).fetch('https://fixture.invalid/fixture-state')).json();
  const ownerBeforeNamed=await inspect();
  claimsOverride={sub:'synthetic-openai-A',email:'subscriber-a@example.invalid','https://api.openai.com/auth':{chatgpt_plan_type:'pro',chatgpt_account_id:'synthetic-account-A'}};
  const authorizationA=await start(connectionA);
  assert.equal((await targetState(connectionB)).pending,undefined);
  const completeA=await send('/gatekeeper/subscription/complete',{accountId:connectionA,callbackUrl:callback(authorizationA)});
  assert.equal(completeA.status,200,await completeA.clone().text());assert.equal((await completeA.json()).provider,'siwc');
  claimsOverride={};
  const deviceAccountBeforeNamed=deviceAccount, deviceSubjectBeforeNamed=deviceSubject;
  deviceAccount='synthetic-account-B';deviceSubject='synthetic-openai-B';
  assert.equal((await send('/gatekeeper/subscription/device/start',{accountId:connectionB,planUsageConfirmed:true})).status,200);
  await targetObject(connectionB).fetch('https://fixture.invalid/fixture-device-time',{method:'POST',body:JSON.stringify({nextAt:Date.now()-1})});
  assert.equal((await send('/gatekeeper/subscription/device/check',{accountId:connectionB})).status,200);
  const namedCatalog=(await (await send('/gatekeeper/subscription/connections')).json()).connections;
  assert.deepEqual(namedCatalog.map(row=>[row.id,row.provider,row.ready]),[['owner','codex',true],[connectionA,'siwc',true],[connectionB,'codex',true]]);
  for (const row of namedCatalog) assert.deepEqual(Object.keys(row).sort(),['id','label','provider','ready']);
  assert.deepEqual({account:accountReads,usage:usageReads},readsBeforeNamed,'catalog reads local readiness without usage requests');
  assert.deepEqual(await (await privateClient.fetch('https://fixture.invalid/connections')).json(),namedCatalog,'trusted catalog needs no user ID');
  for (const accountId of [connectionA,connectionB,'owner',undefined]) {
    if(accountId==='owner'||accountId===undefined) deviceAccount=deviceAccountBeforeNamed;
    const response=await privateClient.fetch('https://fixture.invalid/infer',{method:'POST',body:JSON.stringify(wire(accountId?{subscriptionAccountId:accountId}:{}))});
    assert.equal(response.status,200);assert.ok((await response.text()).includes('"type":"done"'));
  }
  const outboundBeforeDenied=outboundUrls.length, eventsBeforeDenied=(await events()).length;
  assert.equal((await privateClient.fetch('https://fixture.invalid/infer',{method:'POST',body:JSON.stringify(wire({userId:other,subscriptionAccountId:connectionA}))})).status,403);
  assert.equal(outboundUrls.length,outboundBeforeDenied);assert.equal((await events()).length,eventsBeforeDenied,'allowlist is checked before catalog, object and credential access');
  const namedA=await targetState(connectionA),namedB=await targetState(connectionB);
  assert.ok(namedA.credential.ciphertext && namedB.codexImageProfile.ciphertext);
  assert.equal(namedA.codexImageProfile,undefined);assert.equal(namedB.credential,undefined);
  const ownerAfterNamed=await inspect();
  for(const key of ['credential','registration','codexImageProfile','codexRegistration','subscriptionProvider','subscriptionAccountInfo']) assert.deepEqual(ownerAfterNamed[key],ownerBeforeNamed[key],'named connections preserve legacy owner state');
  const storedInventory=ownerAfterNamed.adminAccounts;
  await put({adminAccounts:[...storedInventory,...Array.from({length:20-storedInventory.length},(_,i)=>({id:`account-00000000-0000-0000-0000-${String(i+10).padStart(12,'0')}`,label:'Inventory fixture'}))]});
  await assertError(await send('/gatekeeper/subscription/connections/create',{label:'Over limit'}),400,'account_limit');
  await put({adminAccounts:storedInventory});
  deviceAccount=deviceAccountBeforeNamed;deviceSubject=deviceSubjectBeforeNamed;
  const browserConnections={connections:[{id:'owner',label:'owner',provider:'siwc',ready:true}]};
  const browserFlush = () => new Promise(resolve => setImmediate(resolve));
  function bootstrapBrowser({token=osToken,hash='#add',responseStatus=200,fetchFailure=false,contentType='text/html',receivedMarker=null}={}) {
    const redirects=[],requests=[];
    const dom=new JSDOM(shell.replace('<script nonce=','<script type="text/plain" nonce='),{url:origin+'/gatekeeper/subscription'+hash,runScripts:'dangerously',beforeParse(window){
      if(token)window.localStorage.setItem('authToken',token);
      window.localStorage.setItem('existing','preserve');
      if(receivedMarker)window.sessionStorage.setItem('gadgets.redirect-login-received',receivedMarker);
      window.fetch=async(url,options)=>{
        requests.push({url,options});
        if(options.method==='GET') {
          if(fetchFailure)throw Error('synthetic-error-must-not-display');
          return{ok:responseStatus===200,status:responseStatus,headers:new Headers({'content-type':contentType}),text:async()=>authenticatedPageHtml};
        }
        return{ok:true,status:200,json:async()=>url.endsWith('/connections')?browserConnections:ready};
      };
    }});
    assert.equal(dom.window.document.querySelector('form'),null,'bootstrap initially has no setup form');
    const script=dom.window.document.querySelector('script').textContent;
    dom.window.Function('location',script)({pathname:'/gatekeeper/subscription',hash,replace:path=>redirects.push(path)});
    return{dom,requests,redirects};
  }
  for(const hash of ['','#add','#connection=owner','#connection=account-00000000-0000-0000-0000-000000000011','#connection=unknown','#callback=do-not-return','#//external.example.invalid']) {
    const safeHash=/^#(?:add|connection=(?:owner|account-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))$/.test(hash)?hash:'';
    const browser=bootstrapBrowser({token:null,hash});
    try {
      await browserFlush();
      assert.deepEqual(browser.redirects,['https://os.example.invalid/?sign_in=oidc&return_to='+encodeURIComponent('/gatekeeper/subscription'+safeHash)]);
      assert.equal(browser.requests.length,0,'missing token goes directly to native OS sign-in');
      assert.equal(browser.dom.window.document.querySelector('form'),null);
      assert.equal(browser.dom.window.localStorage.getItem('existing'),'preserve');
      assert.equal(browser.dom.window.sessionStorage.length,0);
    }finally{browser.dom.window.close();}
  }
  for(const responseStatus of [401,403,500]) {
    const browser=bootstrapBrowser({responseStatus});
    try {
      await browserFlush();
      assert.equal(browser.requests.length,1);
      const {url,options}=browser.requests[0];
      assert.equal(url,'/gatekeeper/subscription');assert.equal(options.method,'GET');
      assert.equal(options.headers.authorization,'Bearer '+osToken);
      assert.equal(options.headers['x-subscription-document-nonce'],documentNonce);
      assert.equal(options.body,undefined);assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');
      assert.equal(browser.dom.window.document.querySelector('form'),null,'failed authorization never renders setup');
      assert.equal(browser.redirects.length,responseStatus===401?1:0,'only unauthenticated sessions navigate to sign-in');
      assert.equal(browser.dom.window.localStorage.getItem('authToken'),responseStatus===401?null:osToken,'401 clears only the stale OS token');
      assert.equal(browser.dom.window.localStorage.getItem('existing'),'preserve');
      if(responseStatus===403)assert.ok(browser.dom.window.document.getElementById('status').textContent.includes('권한이 없습니다'));
      assert.ok(!browser.dom.window.document.body.textContent.includes(osToken));
    }finally{browser.dom.window.close();}
  }
  for(const options of [{fetchFailure:true},{contentType:'application/json'}]) {
    const browser=bootstrapBrowser(options);
    try {
      await browserFlush();assert.equal(browser.redirects.length,0);assert.equal(browser.dom.window.document.querySelector('form'),null);
      assert.equal(browser.dom.window.document.getElementById('status').textContent,'로그인 상태를 확인하지 못했습니다. 페이지를 새로고침하세요.');
      assert.ok(!browser.dom.window.document.body.textContent.includes('synthetic-error'));
    }finally{browser.dom.window.close();}
  }
  const receivedMarker=JSON.stringify({returnTo:'/gatekeeper/subscription#add',expiresAt:Date.now()+30*60*1000});
  for(const responseStatus of [401,200]) {
    const browser=bootstrapBrowser({responseStatus,receivedMarker});
    try {
      await browserFlush();await browserFlush();
      assert.equal(browser.dom.window.sessionStorage.getItem('gadgets.redirect-login-received'),responseStatus===401?receivedMarker:null,'newly received sessions rejected by the subscription keep the native recovery bound; an authorized document clears it');
      assert.equal(browser.redirects.length,responseStatus===401?1:0);
    }finally{browser.dom.window.close();}
  }
  const rendered=bootstrapBrowser();
  try {
    await browserFlush();await browserFlush();
    assert.equal(rendered.redirects.length,0);
    for(const id of ['start','complete','device-start','add-connection'])assert.ok(rendered.dom.window.document.getElementById(id),'authenticated bootstrap renders '+id);
    assert.ok(rendered.requests.some(item=>item.url.endsWith('/status')&&item.options.method==='POST'),'returned setup script executes after document replacement');
    assert.equal(rendered.dom.window.document.activeElement.id,'connection-label','authenticated bootstrap preserves #add');
    assert.equal(rendered.dom.window.document.getElementById('setup-start').disabled,false);
    for(const node of rendered.dom.window.document.querySelectorAll('style,script'))assert.equal(node.nonce,documentNonce);
    assert.equal(rendered.dom.window.localStorage.getItem('authToken'),osToken);assert.equal(rendered.dom.window.localStorage.getItem('existing'),'preserve');assert.equal(rendered.dom.window.sessionStorage.length,0);
  }finally{rendered.dom.window.close();}
  const posted = [];
  const dom = new JSDOM(subscriptionPage("synthetic-nonce"), { url: origin + "/gatekeeper/subscription", runScripts: "dangerously", beforeParse(window) {
    window.fetch = async (url, options) => {
      posted.push({ url, options });
      return { ok: true, json: async () => url.endsWith("/connections") ? browserConnections : url.endsWith("/start") ? { authorizationUrl: "https://auth.openai.com/api/accounts/authorize?synthetic" } : ready };
    };
  } });
  try {
    const { document, Event } = dom.window;
    assert.equal(document.getElementById("email"), null);
    document.getElementById("approval").checked = true;
    document.getElementById("start").dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.getElementById("login").target, "_blank");
    assert.equal(document.getElementById("login").rel, "noopener noreferrer");
    assert.equal(document.getElementById("authorization").hidden, false);
    document.getElementById("callback").value = callback(authorization);
    document.getElementById("complete").dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(document.getElementById("callback").value, "", "callback cleared before asynchronous request finishes");
    await new Promise(resolve => setImmediate(resolve));
    const complete = posted.find(item => item.url.endsWith("/complete"));
    assert.equal(JSON.parse(complete.options.body).callbackUrl, callback(authorization));
    assert.equal(complete.options.method, "POST");
    assert.equal(complete.options.referrerPolicy, "no-referrer");
    assert.equal(dom.window.location.href, origin + "/gatekeeper/subscription");
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.ok(document.getElementById("status").textContent.includes("연결 준비 완료"));
    assert.ok(document.getElementById("identity").textContent.includes(other));
    assert.ok(document.getElementById("identity").textContent.includes("제공되지 않음"));
    assert.equal(document.getElementById("metadata-refresh").hidden, false);
    document.getElementById("metadata-refresh").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(posted.some(item => item.url.endsWith("/refresh")));
    assert.deepEqual(JSON.parse(posted.find(item => item.url.endsWith("/start")).options.body), { planUsageConfirmed: true });
    assert.equal(document.getElementById("authorization").hidden, true);
    assert.equal(document.getElementById("login").hasAttribute("href"), false);
  } finally { dom.window.close(); }
  const devicePosts = [], timers = new Map(); let timerId = 0;
  const browserAttempt = {verificationUrl:'https://auth.openai.com/codex/device',userCode:'BROWSER-CODE',expiresAt:new Date(Date.now()+900000).toISOString(),nextCheckAt:new Date(Date.now()+1000).toISOString()};
  const browserCodex = {...ready,provider:'codex',codexInferenceReady:true,device:null,identity:{...ready.identity,email:'device@example.invalid'}};
  const deviceDom = new JSDOM(subscriptionPage('synthetic-nonce','access',true),{url:origin+'/gatekeeper/subscription',runScripts:'dangerously',beforeParse(window){
    window.setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};window.clearTimeout=id=>timers.delete(id);
    window.fetch=async(url,options)=>{devicePosts.push({url,options});const value=url.endsWith('/connections')?browserConnections:url.endsWith('/device/start')?browserAttempt:url.endsWith('/device/check')?browserCodex:url.endsWith('/account-info')?{checkedAt:new Date().toISOString(),account:{status:'available',workspaceName:'Selected browser workspace',planType:'plus'},usage:{status:'available',planType:'plus',primaryWindow:{usedPercent:12,resetAt:1800000000}}}:ready;return{ok:true,status:200,json:async()=>value};};
  }});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    const document=deviceDom.window.document;
    assert.ok(document.getElementById('device-start') && document.getElementById('complete'),'both choices coexist');
    document.getElementById('device-approval').checked=true;
    document.getElementById('device-start').dispatchEvent(new deviceDom.window.Event('submit',{cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(document.getElementById('device-code').textContent,'BROWSER-CODE');
    assert.equal(document.getElementById('device-login').href,browserAttempt.verificationUrl);
    assert.equal(timers.size,1); const timer=[...timers.values()][0]; assert.ok(timer.delay>=1000);
    assert.equal(devicePosts.filter(item=>item.url.endsWith('/device/check')).length,0,'no early browser polling');
    await timer.callback();
    assert.equal(document.getElementById('device').hidden,true);
    assert.equal(document.getElementById('device-code').textContent,'');
    assert.ok(document.getElementById('active-provider').textContent.includes('Codex device'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(document.getElementById('account-info').textContent.includes('12%'));
    assert.ok(!document.getElementById('account-info').textContent.includes('1970'));
    document.getElementById('device-start').dispatchEvent(new deviceDom.window.Event('submit',{cancelable:true}));
    await new Promise(resolve=>setImmediate(resolve));
    const staleTimer=[...timers.values()].at(-1), checksBefore=devicePosts.filter(item=>item.url.endsWith('/device/check')).length;
    deviceDom.window.dispatchEvent(new deviceDom.window.Event('pagehide'));
    await staleTimer.callback();
    assert.equal(devicePosts.filter(item=>item.url.endsWith('/device/check')).length,checksBefore,'navigation stops old generation');
    assert.equal(deviceDom.window.localStorage.length,0); assert.equal(deviceDom.window.sessionStorage.length,0);
    assert.deepEqual(JSON.parse(devicePosts.find(item=>item.url.endsWith('/device/start')).options.body),{planUsageConfirmed:true});
  } finally {deviceDom.window.close();}
  const namedPosts=[], namedTimers=new Map(), held=new Map();let namedTimerId=0;
  const browserA='account-00000000-0000-0000-0000-000000000011',browserB='account-00000000-0000-0000-0000-000000000012',browserC='account-00000000-0000-0000-0000-000000000013';
  const namedConnections=[{id:'owner',label:'owner',provider:'siwc',ready:true},{id:browserA,label:'Connection A',provider:'siwc',ready:true},{id:browserB,label:'Connection B',provider:'siwc',ready:true}];
  const namedStatus=id=>({...ready,provider:'siwc',codexInferenceReady:true,identity:{...ready.identity,email:id+'@example.invalid'}});
  const hold=(path,id)=>{let release;const promise=new Promise(resolve=>release=resolve);held.set(path+':'+id,promise);return release;};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const namedDom=new JSDOM(subscriptionPage('synthetic-nonce','access',true),{url:origin+'/gatekeeper/subscription#add',runScripts:'dangerously',beforeParse(window){
    window.setTimeout=(callback,delay)=>{const id=++namedTimerId;namedTimers.set(id,{callback,delay});return id;};window.clearTimeout=id=>namedTimers.delete(id);
    window.fetch=async(url,options)=>{
      const input=JSON.parse(options.body),id=input.accountId??'owner',path=url.slice('/gatekeeper/subscription/'.length);namedPosts.push({path,input});
      let value;
      const waiting=held.get(path+':'+id);
      if(waiting){held.delete(path+':'+id);value=await waiting;}
      else if(path==='connections') value={connections:namedConnections};
      else if(path==='connections/create'){namedConnections.push({id:browserC,label:input.label,provider:'siwc',ready:false});value={id:browserC,connections:namedConnections};}
      else if(path==='account-info')value={account:{status:'available',workspaceName:id},usage:{status:'unavailable'}};
      else if(path==='device/start')value=browserAttempt;
      else value=namedStatus(id);
      return{ok:true,status:200,json:async()=>value};
    };
  }});
  try{
    await flush();const document=namedDom.window.document,Event=namedDom.window.Event;
    assert.equal(document.activeElement.id,'connection-label','#add focuses the named add form');
    assert.equal(document.getElementById('connection-select').options.length,3);
    document.getElementById('connection-label').value='Connection C';document.getElementById('add-connection').dispatchEvent(new Event('submit',{cancelable:true}));await flush();
    assert.equal(document.getElementById('connection-select').value,browserC);assert.equal(document.getElementById('connection-select').options.length,4);
    assert.deepEqual(namedPosts.find(item=>item.path==='connections/create').input,{label:'Connection C'});
    const select=id=>{document.getElementById('connection-select').value=id;document.getElementById('connection-select').dispatchEvent(new Event('change'));};
    const releaseInfo=hold('account-info',browserA);select(browserA);await flush();
    const releaseStart=hold('start',browserA),releaseComplete=hold('complete',browserA),releaseRefresh=hold('refresh',browserA),releaseDevice=hold('device/start',browserA);
    document.getElementById('approval').checked=true;document.getElementById('start').dispatchEvent(new Event('submit',{cancelable:true}));
    document.getElementById('callback').value='http://127.0.0.1:1455/auth/callback?synthetic';document.getElementById('complete').dispatchEvent(new Event('submit',{cancelable:true}));
    document.getElementById('metadata-refresh').click();document.getElementById('device-approval').checked=true;document.getElementById('device-start').dispatchEvent(new Event('submit',{cancelable:true}));
    document.getElementById('callback').value='discard-on-switch';select(browserB);await flush();
    releaseInfo({account:{status:'available',workspaceName:'Stale A workspace'},usage:{status:'available',primaryWindow:{usedPercent:99}}});
    releaseStart({authorizationUrl:'https://auth.openai.com/api/accounts/authorize?stale'});releaseComplete(namedStatus(browserA));releaseRefresh(namedStatus(browserA));releaseDevice(browserAttempt);await flush();
    assert.ok(document.getElementById('identity').textContent.includes(browserB));assert.ok(!document.getElementById('identity').textContent.includes(browserA),'same-provider stale identity is ignored');
    assert.ok(document.getElementById('account-info').textContent.includes(browserB));assert.ok(!document.getElementById('account-info').textContent.includes('99%'));
    assert.equal(document.getElementById('authorization').hidden,true);assert.equal(document.getElementById('login').hasAttribute('href'),false);
    assert.equal(document.getElementById('callback').value,'');assert.equal(document.getElementById('device').hidden,true);assert.equal(namedTimers.size,0);
    for(const path of ['start','complete','refresh','device/start','account-info'])assert.ok(namedPosts.some(item=>item.path===path&&item.input.accountId===browserA),'every request captures its target');
    select(browserA);await flush();document.getElementById('device-approval').checked=true;document.getElementById('device-start').dispatchEvent(new Event('submit',{cancelable:true}));await flush();
    assert.equal(namedTimers.size,1);const releasePoll=hold('device/check',browserA),poll=[...namedTimers.values()][0].callback();await flush();select(browserB);await flush();
    releasePoll(namedStatus(browserA));await poll;assert.equal(namedTimers.size,0);assert.ok(document.getElementById('identity').textContent.includes(browserB),'late poll never changes selected identity');
    const releaseStatus=hold('status',browserA);select(browserA);select(browserB);await flush();releaseStatus(namedStatus(browserA));await flush();
    assert.ok(document.getElementById('identity').textContent.includes(browserB),'late status never changes selected identity');
    namedDom.window.location.hash='connection='+browserA;namedDom.window.dispatchEvent(new namedDom.window.HashChangeEvent('hashchange'));await flush();assert.equal(document.getElementById('connection-select').value,browserA,'known hash selects its connection');
    namedDom.window.location.hash='connection='+unknownId;namedDom.window.dispatchEvent(new namedDom.window.HashChangeEvent('hashchange'));await flush();assert.equal(document.getElementById('connection-select').value,browserA,'unknown hash does not select a target');
    select(browserB);await flush();document.getElementById('refresh').click();await flush();assert.equal(document.getElementById('connection-select').value,browserB,'refresh preserves the current editor selection');
    assert.equal(namedDom.window.localStorage.length,0);assert.equal(namedDom.window.sessionStorage.length,0);
  }finally{namedDom.window.close();}
  for (const denialStatus of [401,403]) for (const failureAt of ['initial', 'start', 'complete']) {
    const unauthorized = failureAt === 'initial';
    let denied = unauthorized;
    const postedOidc = [], navigations=[];
    let resolveStatus;
    const statusWait = new Promise(resolve => { resolveStatus = resolve; });
    const dom = new JSDOM(subscriptionPage("synthetic-nonce", "oidc",true).replace('<script nonce=','<script type="text/plain" nonce='), { url: origin + "/gatekeeper/subscription#connection=owner", runScripts: "dangerously", beforeParse(window) {
      window.localStorage.setItem("authToken", osToken);
      window.localStorage.setItem("existing", "preserve");
      window.Storage.prototype.setItem = () => { throw Error("unexpected_storage_write"); };
      window.fetch = async (url, options) => {
        postedOidc.push({ url, options });
        if (postedOidc.length === 1) await statusWait;
        return { ok: !denied, status: denied ? denialStatus : 200, json: async () => denied ? { error: denialStatus===401?"access_denied":"admin_denied" } : url.endsWith("/connections") ? browserConnections : ready };
      };
    } });
    dom.window.Function('location',dom.window.document.querySelector('script').textContent)({hash:'#connection=owner',replace:path=>navigations.push(path)});
    try {
      const { document, Event } = dom.window;
      assert.equal(document.getElementById("setup-start").disabled, true);
      assert.equal(document.getElementById("setup-complete").disabled, true);
      document.getElementById("start").dispatchEvent(new Event("submit", { cancelable: true }));
      assert.equal(postedOidc.length, 1, "controls cannot submit before authenticated status");
      resolveStatus();
      await browserFlush();await browserFlush();
      assert.equal(document.getElementById("setup-start").disabled, unauthorized);
      assert.equal(document.getElementById("setup-complete").disabled, unauthorized);
      assert.equal(document.getElementById("sign-in").hidden, !(unauthorized&&denialStatus===401));
      assert.equal(document.querySelector("#sign-in a").getAttribute("href"), "/?sign_in=oidc&return_to="+encodeURIComponent('/gatekeeper/subscription#connection=owner'));
      assert.equal(postedOidc[0].options.headers.authorization, "Bearer " + osToken);
      if (!unauthorized) {
        if(denialStatus===401)dom.window.localStorage.removeItem("authToken");
        denied = true;
        document.getElementById("callback").value = "http://127.0.0.1:1455/auth/callback?synthetic";
        document.getElementById('device-code').textContent='stale-device-code';
        document.getElementById('device-login').href='https://auth.openai.com/codex/device';
        document.getElementById(failureAt).dispatchEvent(new Event("submit", { cancelable: true }));
        await browserFlush();
        assert.equal(postedOidc.find(item => item.url.endsWith("/" + failureAt)).options.headers.authorization,denialStatus===401?undefined:"Bearer "+osToken,"every POST reads the current OS token");
        assert.equal(document.getElementById("setup-start").disabled, true);
        assert.equal(document.getElementById("setup-complete").disabled, true);
        assert.equal(document.getElementById(failureAt + "-button").matches(":disabled"), true, "authorization failure stays disabled through finally");
        assert.equal(document.getElementById("sign-in").hidden, denialStatus!==401);
        assert.equal(document.getElementById('callback').value,'');assert.equal(document.getElementById('device-code').textContent,'');assert.equal(document.getElementById('device-login').hasAttribute('href'),false);
      }
      assert.deepEqual(navigations,denialStatus===401?["/?sign_in=oidc&return_to="+encodeURIComponent('/gatekeeper/subscription#connection=owner')]:[],"only 401 automatically starts native same-tab sign-in");
      assert.equal(dom.window.localStorage.getItem('authToken'),denialStatus===401?null:osToken);
      assert.equal(document.getElementById('authorization').hidden,true);assert.equal(document.getElementById('login').hasAttribute('href'),false);
      assert.ok(document.getElementById('status').textContent.includes(denialStatus===401?'OS 로그인으로':'권한이 없습니다'));
      denied = false;
      document.getElementById("refresh").click();
      await browserFlush();
      assert.ok(postedOidc.some(item => item.url.endsWith("/status")));
      for (const id of ["setup-start", "setup-complete", "start-button", "complete-button"]) assert.equal(document.getElementById(id).matches(":disabled"), false, "successful status refresh restores " + id);
      assert.equal(document.getElementById("sign-in").hidden, true);
      for (const post of postedOidc) assert.ok(post.url.startsWith("/gatekeeper/subscription/"));
      assert.equal(dom.window.localStorage.length,denialStatus===401?1:2);
      assert.equal(dom.window.localStorage.getItem("existing"), "preserve");
      assert.equal(dom.window.sessionStorage.length, 0);
      assert.ok(!document.body.textContent.includes(osToken));
    } finally { dom.window.close(); }
  }
  for (const secret of [osToken, accessToken, refreshToken, "synthetic-code-never-log", nonce, email, other, "renamed@example.invalid"]) assert.ok(!logs.join("\n").includes(secret), "no callback, identity or grant in runtime logs");
  assert.ok(outboundUrls.every(url => !url.includes("callback") && !url.includes("code=") && !url.includes(osToken)));
  const config = JSON.parse((await readFile(join(here, "wrangler.example.jsonc"), "utf8")));
  assert.deepEqual(config.durable_objects.bindings, [{ name: "Credentials", class_name: "Credentials" }]);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["Credentials"] }]);
  const oidcConfig = JSON.parse(await readFile(join(here, "wrangler.oidc.example.jsonc"), "utf8"));
  assert.equal(oidcConfig.vars.SUBSCRIPTION_AUTH_MODE, "oidc");
  assert.deepEqual(oidcConfig.services, [{ binding: "OS_SESSION", service: "example-os-workshop", entrypoint: "SubscriptionSetupSession" }]);
  assert.equal(oidcConfig.vars.CF_ACCESS_ISS, undefined);
  assert.equal(oidcConfig.vars.CF_ACCESS_AUD, undefined);
  assert.deepEqual(oidcConfig.durable_objects, config.durable_objects);
  assert.deepEqual(oidcConfig.migrations, config.migrations);
  console.log(JSON.stringify({ result: "PASS", nativeRuntime: "Miniflare/workerd", checks: ["Access signature/issuer/audience/expiry/admin", "OIDC private session and exact issuer/subject/email pins before Credentials", "OIDC no-form bootstrap, authenticated document GET and matching CSP nonce, same-tab 401 recovery and 403 denial", "same-origin JSON bounded requests before DO", "automatic verified SIWC identity, legacy pins and concurrent registration conflicts", "independent encrypted SIWC and Codex completion in either order", "device empty/arbitrary pending objects, interval, expiry and terminal denial or invalid response", "explicit active transport and unavailable selection fails closed", "account cache privacy and in-flight selection change", "both login choices and bounded device polling with navigation guard", "automatic metadata and manual callback UI with no browser persistence", "owner plus two named isolated connections, bounded catalog and explicit private inference selectors", "rendered add/list/switch ignores late status, login, metadata and device-poll responses"], tokenCalls, inferenceCalls, temporaryBuild: work }));
} finally { await mf.dispose(); }
