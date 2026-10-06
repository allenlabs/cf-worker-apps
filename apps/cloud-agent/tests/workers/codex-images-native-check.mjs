import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { piTextModules } from "./pi-modules.mjs";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
const email = "native-image@example.invalid", admin = "native-admin@example.invalid", clientId = "fixture-codex-client";
const session = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
await writeFile("build/pi/codex-images-wrapper.js", `import worker,{Credentials as BaseCredentials} from './index.js';
export default worker;
export class Credentials extends BaseCredentials {
 async fetch(request){try{const path=new URL(request.url).pathname;
  if(path==='/seed'){await this.ctx.storage.put('adminSession:${hash(session)}',{expiresAt:Date.now()+3600000,sealed:await this.seal({principal:{email:'${admin}',role:'super_admin',issuer:'https://sso.example.invalid',subject:'fixture-admin'},csrf:'${csrf}'})});return Response.json({ok:true});}
  if(path==='/ready'){const pending=await this.open(await this.ctx.storage.get('codexImagePending'));await this.ctx.storage.put('codexImagePending',await this.seal({...pending,nextAt:0}));return Response.json({ok:true});}
  if(path==='/inspect')return Response.json({profile:await this.ctx.storage.get('codexImageProfile'),pending:await this.ctx.storage.get('codexImagePending'),credential:await this.ctx.storage.get('credential')});
  if(path==='/pin-other'){await this.ctx.storage.put('registration',{subjectHash:'${hash("fixture-subject")}',accountHash:'${hash("other-account")}'});return Response.json({ok:true});}
  if(path==='/access')return Response.json(await this.codexImageAccess());
  return Response.json({error:'fixture_route_missing'},{status:404});
 }catch(error){return Response.json({error:error.message},{status:400});}}
}`);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-image-key", alg: "RS256", use: "sig" };
let overrides = {}, pendingStatus = 200, exchangeCalls = 0, jwksCalls = 0;
const jwt = () => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: clientId, sub: "fixture-subject", email, email_verified: true, exp: Date.now() / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "pro" }, ...overrides })).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
};
const verifier = "fixture-code-verifier-abcdefghijklmnopqrstuvwxyz", challenge = createHash("sha256").update(verifier).digest("base64url");
const persist = await mkdtemp(join(tmpdir(), "codex-images-native-"));
const config = {
  name: "cloud-agent", modulesRoot: resolve("build/pi"),
  modules: ["codex-images-wrapper.js", "index.js"].map(name => ({ type: "ESModule", path: resolve("build/pi", name) })).concat(await piTextModules(resolve("build/pi"))),
  compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { Credentials: { className: "Credentials", useSQLite: true } }, resourcePersistencePath: persist,
  bindings: { PUBLIC_ORIGIN: "https://agent.example.invalid", OWNER_EMAIL_SHA256: hash(email), TOKEN_WRAPPING_KEY: randomBytes(32).toString("base64url"), CODEX_IMAGE_CLIENT_ID: clientId, SUPER_ADMIN_EMAILS: JSON.stringify([admin]), SSO_ISSUER: "https://sso.example.invalid", TENANT_ID: "fixture-tenant" },
  outboundService: async request => {
    if (request.url.endsWith("/.well-known/jwks.json")) { jwksCalls++; return Response.json({ keys: [jwk] }); }
    if (request.url.endsWith("/deviceauth/usercode")) { assert.deepEqual(await request.json(), { client_id: clientId }); return Response.json({ device_auth_id: "fixture-device", user_code: "FIXTURE-CODE", interval: "1" }); }
    if (request.url.endsWith("/deviceauth/token")) {
      assert.deepEqual(await request.json(), { device_auth_id: "fixture-device", user_code: "FIXTURE-CODE" });
      return pendingStatus === 200 ? Response.json({ authorization_code: "fixture-code", code_verifier: verifier, code_challenge: challenge }) : new Response(null, { status: pendingStatus });
    }
    assert.equal(request.url, "https://auth.openai.com/oauth/token"); exchangeCalls++;
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get("client_id"), clientId); assert.equal(form.get("resource"), null);
    return Response.json({ access_token: "fixture-image-access", refresh_token: "fixture-image-refresh", id_token: jwt(), expires_in: 3600, token_type: "Bearer" });
  }
};
let mf = new Miniflare(convertV4MiniflareOptions(config));
const direct = async path => { const ns = await mf.getDurableObjectNamespace("Credentials"); return ns.get(ns.idFromName("owner")).fetch("https://fixture.invalid" + path); };
const post = (path, body, authenticated = true, csrfValue = csrf) => mf.dispatchFetch("https://agent.example.invalid" + path, { method: "POST", headers: { "content-type": "application/json", origin: "https://agent.example.invalid", ...(authenticated ? { cookie: `__Host-cloud_agent_session=${session}`, "x-csrf-token": csrfValue } : {}) }, body: JSON.stringify(body) });
try {
  assert.equal((await post("/api/images/start", { id: "owner" }, false)).status, 401);
  await direct("/seed");
  assert.equal((await post("/api/images/start", { id: "owner" }, true, "wrong")).status, 403);
  assert.equal((await post("/api/images/start", { id: "missing" })).status, 404);
  assert.equal((await post("/api/images/disconnect", { id: "owner" })).status, 400);
  const start = await post("/api/images/start", { id: "owner" }); assert.equal(start.status, 200, await start.clone().text()); assert.equal((await start.json()).userCode, "FIXTURE-CODE");
  pendingStatus = 403; await direct("/ready"); const pending = await post("/api/images/check", { id: "owner" }); assert.equal(pending.status, 200); assert.equal((await pending.json()).pending, true); assert.equal(exchangeCalls, 0);
  pendingStatus = 200; await direct("/ready"); const connected = await post("/api/images/check", { id: "owner" }); assert.equal(connected.status, 200, await connected.clone().text());
  const status = await connected.json(); assert.equal(status.connected, true); assert.equal(status.identity.email, email); assert.equal(status.identity.accountId, "fixture-account"); assert.equal(jwksCalls, 1);
  assert(!JSON.stringify(status).includes("fixture-image-access"));
  const sealed = await (await direct("/inspect")).json(); assert(sealed.profile.ciphertext); assert(!JSON.stringify(sealed).includes("fixture-image-refresh")); assert.equal(sealed.credential, undefined);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(config));
  const restarted = await mf.dispatchFetch("https://agent.example.invalid/status", { headers: { cookie: `__Host-cloud_agent_session=${session}` } }); assert.equal(restarted.status, 200); assert.equal((await restarted.json()).image.connected, true); assert.equal(exchangeCalls, 1);
  await direct("/pin-other"); const changed = await direct("/access"); assert.equal(changed.status, 400); assert.equal((await changed.json()).error, "codex_image_identity_mismatch");
  assert.equal((await post("/api/images/disconnect", { id: "owner", confirmed: true })).status, 200);
  overrides = { aud: "wrong-client" }; await post("/api/images/start", { id: "owner" }); await direct("/ready"); const invalid = await post("/api/images/check", { id: "owner" }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, "id_token_audience_mismatch");
  console.log("Native Codex image checks passed: SSO/CSRF routes, real RS256/JWKS callback, encrypted separate storage, restart, registration pin and audience rejection; outbound OAuth fully mocked.");
} finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
