import assert from "node:assert/strict";
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
let nonce, tokenCalls = 0, inferenceCalls = 0, claimsOverride = {}, outboundUrls = [];
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
  async start(approval) { events.push('start:' + approval); return super.start(approval); }
  async startCodex() { events.push('startCodex'); throw Error('wrong_login_flow'); }
  async status() { events.push('status'); if(statusError)throw Error(${JSON.stringify(accessToken)});return super.status(); }
  async complete(callback) { events.push('complete'); return super.complete(callback); }
  async access(force) { events.push('access'); return super.access(force); }
  async codexAccess() { events.push('codexAccess'); throw Error('wrong_inference_provider'); }
  async fetch() { return Response.json(Object.fromEntries(await this.ctx.storage.list())); }
}
export class Probe extends WorkerEntrypoint {
  events() { return events; }
  fail(value) { statusError=value; }
}
`);
await writeFile(join(work, "client.js"), `export default { async fetch(request, env) {
  const path=new URL(request.url).pathname;
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
  TENANT_ID: "synthetic-subscription", PRODUCT_NAME: "Synthetic subscription", SUBSCRIPTION_INFERENCE_PROVIDER: "siwc",
  INFERENCE_BRIDGE_PROVIDER: "siwc", INFERENCE_BRIDGE_ACCOUNT_ID: "owner", INFERENCE_BRIDGE_MODEL: model,
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
  if (request.url === "https://auth.openai.com/api/accounts/oauth/token") {
    tokenCalls++;
    const input = new URLSearchParams(await request.text());
    assert.equal(input.get("grant_type"), "authorization_code");
    assert.equal(input.get("client_id"), "synthetic-client");
    assert.equal(input.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
    assert.equal(input.get("resource"), "https://api.openai.com/v1");
    assert.match(input.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600,
      scope: "resource.invoke chatgpt.tokens.use.direct", id_token: jwt(openaiKeys, openaiJwk.kid, {
        iss: "https://auth.openai.com", aud: "synthetic-client", sub: "synthetic-openai-owner", email,
        email_verified: true, nonce, exp: Date.now() / 1000 + 3600,
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "synthetic-account" }, ...claimsOverride,
      }),
    });
  }
  assert.equal(request.url, "https://api.openai.com/v1/responses", "outbound network is fixture-only");
  inferenceCalls++;
  assert.equal(request.headers.get("authorization"), `Bearer ${accessToken}`);
  const input = await request.json();
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
const start = async (selectedEmail = email) => {
  const response = await send("/gatekeeper/subscription/start", { email: selectedEmail, planUsageConfirmed: true });
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
  assert.equal(await sessionCalls(), 0, "OIDC GET never verifies or reads an account session");
  const shell = await publicShell.text();
  assert.ok(shell.includes('id="setup-start" disabled') && shell.includes('id="setup-complete" disabled'));
  assert.ok(!shell.includes(email) && !shell.includes(oidcSubject) && !shell.includes(oidcIssuer) && !shell.includes(osToken));
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
  const oidcStart = await oidcSend(osToken, { email, planUsageConfirmed: true }, "start");
  assert.equal(oidcStart.status, 200);
  assert.equal(new URL((await oidcStart.json()).authorizationUrl).searchParams.get("client_id"), "dynamic_agent_client");

  const production = await mf.getWorker("native-production");
  const productionPage = await production.fetch(origin + "/gatekeeper/subscription", { method: "GET", headers: headers() });
  assert.equal(productionPage.status, 200, "unmodified production artifact runs under workerd: " + await productionPage.text());
  const freshProduction = await production.fetch(origin + "/gatekeeper/subscription/start", { method: "POST", headers: headers(), body: JSON.stringify({ email, planUsageConfirmed: true }) });
  assert.equal(freshProduction.status, 200);
  assert.equal(new URL((await freshProduction.json()).authorizationUrl).searchParams.get("client_id"), "dynamic_agent_client", "unmodified production starts a new namespace grant");
  for (const path of ["/gatekeeper/subscription", "/gatekeeper/subscription/status", "/gatekeeper/subscription/start", "/gatekeeper/subscription/complete"]) {
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
  for (const bad of [null, [], { accountId: "arbitrary" }, { email, planUsageConfirmed: false }, { email, planUsageConfirmed: true, accountId: "arbitrary" }]) {
    await assertError(await send("/gatekeeper/subscription/start", bad), 400, bad === null || Array.isArray(bad) ? "body_invalid" : "start_input_invalid");
  }
  await assertError(await send("/gatekeeper/subscription/status", { accountId: "arbitrary" }), 400, "body_invalid");
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
  assert.deepEqual(await response.json(), { connected: false, identityVerified: false, loginPending: false, planUsageConfirmed: false, siwcInferenceReady: false, identity: null });
  const notReady = await privateClient.fetch("https://fixture.invalid/infer", { method: "POST", body: JSON.stringify(wire()) });
  assert.equal(notReady.status, 403);
  assert.equal(inferenceCalls, 0);

  let authorization = await start();
  assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
  const firstHost = authorization.searchParams.get("ext_agent_host_id");
  const pending = await inspect();
  assert.ok(pending.pending.ciphertext);
  assert.equal(pending.conversationTenant, bindings.TENANT_ID);
  assert.equal(pending.identityPolicy.expectedEmailHash, createHash("sha256").update(email).digest("hex"));
  assert.ok(!JSON.stringify(pending).includes(nonce));
  await assertError(await send("/gatekeeper/subscription/start", { email: other, planUsageConfirmed: true }), 400, "account_identity_policy_pinned");
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization).replace("state=", "state=wrong") }), 400, "callback_state_mismatch");
  assert.equal(tokenCalls, 0);
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, "oauth_attempt_expired");
  claimsOverride = { email: other };
  authorization = await start();
  await assertError(await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) }), 400, "selected_email_mismatch");
  claimsOverride = {};
  authorization = await start();
  response = await send("/gatekeeper/subscription/complete", { callbackUrl: callback(authorization) });
  assert.equal(response.status, 200);
  const ready = await response.json();
  assert.deepEqual(ready, { connected: true, identityVerified: true, loginPending: false, planUsageConfirmed: true, siwcInferenceReady: true, identity: { email, planType: "pro", workspaceName: null } });
  const stored = await inspect();
  assert.ok(stored.credential.ciphertext && stored.identity.ciphertext);
  assert.equal(stored.pending, undefined);
  for (const secret of [accessToken, refreshToken, email, "synthetic-code-never-log", nonce]) assert.ok(!JSON.stringify(stored).includes(secret), "no unencrypted grant/callback/identity in DO state");
  assert.equal(stored.registration.clientId, "synthetic-client");
  await assertError(await send("/gatekeeper/subscription/start", { email: other, planUsageConfirmed: true }), 400, "account_identity_policy_pinned");
  authorization = await start();
  assert.equal(authorization.searchParams.get("client_id"), "synthetic-client");
  assert.equal(authorization.searchParams.get("ext_agent_host_id"), firstHost);
  assert.equal((await (await send("/gatekeeper/subscription/status")).json()).siwcInferenceReady, true, "repeat start keeps existing grant ready");
  assert.ok(!(await events()).includes("startCodex"));
  assert.ok((await events()).includes("start:true"));

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

  const posted = [];
  const dom = new JSDOM(subscriptionPage("synthetic-nonce"), { url: origin + "/gatekeeper/subscription", runScripts: "dangerously", beforeParse(window) {
    window.fetch = async (url, options) => {
      posted.push({ url, options });
      return { ok: true, json: async () => url.endsWith("/start") ? { authorizationUrl: "https://auth.openai.com/api/accounts/authorize?synthetic" } : ready };
    };
  } });
  try {
    const { document, Event } = dom.window;
    document.getElementById("email").value = email;
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
    assert.ok(document.getElementById("identity").textContent.includes(email));
    assert.equal(document.getElementById("authorization").hidden, true);
    assert.equal(document.getElementById("login").hasAttribute("href"), false);
  } finally { dom.window.close(); }
  for (const failureAt of ['initial', 'start', 'complete']) {
    const unauthorized = failureAt === 'initial';
    let denied = unauthorized;
    const postedOidc = [];
    let resolveStatus;
    const statusWait = new Promise(resolve => { resolveStatus = resolve; });
    const dom = new JSDOM(subscriptionPage("synthetic-nonce", "oidc"), { url: origin + "/gatekeeper/subscription", runScripts: "dangerously", beforeParse(window) {
      window.localStorage.setItem("authToken", osToken);
      window.localStorage.setItem("existing", "preserve");
      window.Storage.prototype.setItem = () => { throw Error("unexpected_storage_write"); };
      window.fetch = async (url, options) => {
        postedOidc.push({ url, options });
        if (postedOidc.length === 1) await statusWait;
        return { ok: !denied, status: denied ? 401 : 200, json: async () => denied ? { error: "access_denied" } : ready };
      };
    } });
    try {
      const { document, Event } = dom.window;
      assert.equal(document.getElementById("setup-start").disabled, true);
      assert.equal(document.getElementById("setup-complete").disabled, true);
      document.getElementById("start").dispatchEvent(new Event("submit", { cancelable: true }));
      assert.equal(postedOidc.length, 1, "controls cannot submit before authenticated status");
      resolveStatus();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(document.getElementById("setup-start").disabled, unauthorized);
      assert.equal(document.getElementById("setup-complete").disabled, unauthorized);
      assert.equal(document.getElementById("sign-in").hidden, !unauthorized);
      assert.equal(document.querySelector("#sign-in a").getAttribute("href"), "/");
      assert.equal(postedOidc[0].options.headers.authorization, "Bearer " + osToken);
      if (!unauthorized) {
        dom.window.localStorage.removeItem("authToken");
        denied = true;
        document.getElementById("callback").value = "http://127.0.0.1:1455/auth/callback?synthetic";
        document.getElementById(failureAt).dispatchEvent(new Event("submit", { cancelable: true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(postedOidc[1].options.headers.authorization, undefined, "every POST reads the current OS token");
        assert.equal(document.getElementById("setup-start").disabled, true);
        assert.equal(document.getElementById("setup-complete").disabled, true);
        assert.equal(document.getElementById(failureAt + "-button").matches(":disabled"), true, "authorization failure stays disabled through finally");
        assert.equal(document.getElementById("sign-in").hidden, false);
      }
      denied = false;
      document.getElementById("refresh").click();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(postedOidc.at(-1).url.endsWith("/status"));
      for (const id of ["setup-start", "setup-complete", "start-button", "complete-button"]) {
        assert.equal(document.getElementById(id).matches(":disabled"), false, "successful status refresh restores " + id);
      }
      assert.equal(document.getElementById("sign-in").hidden, true);
      for (const post of postedOidc) assert.ok(post.url.startsWith("/gatekeeper/subscription/"));
      assert.equal(dom.window.localStorage.length, unauthorized ? 2 : 1);
      assert.equal(dom.window.localStorage.getItem("existing"), "preserve");
      assert.equal(dom.window.sessionStorage.length, 0);
      assert.ok(!document.body.textContent.includes(osToken));
    } finally { dom.window.close(); }
  }
  for (const secret of [osToken, accessToken, refreshToken, "synthetic-code-never-log", nonce, email]) assert.ok(!logs.join("\n").includes(secret), "no callback, identity or grant in runtime logs");
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
  console.log(JSON.stringify({ result: "PASS", nativeRuntime: "Miniflare/workerd", checks: ["Access signature/issuer/audience/expiry/admin", "OIDC private session and exact issuer/subject/email pins before Credentials", "OIDC static shell and authenticated UI gating", "same-origin JSON bounded requests before DO", "fresh direct SIWC grant with pinned identity", "private SIWC inference and sanitized outputs", "Korean manual callback UI with no browser persistence"], tokenCalls, inferenceCalls, temporaryBuild: work }));
} finally { await mf.dispose(); }
