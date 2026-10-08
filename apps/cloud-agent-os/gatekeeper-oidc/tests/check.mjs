import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.argv[2] ?? process.env.CLOUDFLARE_OS_SOURCE ?? "cloudflare-os");
const fromUpstream = createRequire(join(upstream, "package.json"));
const fromGoogle = createRequire(join(upstream, "packages/gatekeeper-google/package.json"));
const fromKit = createRequire(join(upstream, "packages/gatekeeper-kit/package.json"));
const fromWrangler = createRequire(fromUpstream.resolve("wrangler/package.json"));
const { build } = fromWrangler("esbuild");
const { Miniflare, convertV4MiniflareOptions } = fromGoogle("miniflare");
const output = await mkdtemp(join(root, ".test-output-"));
const issuer = "https://identity.example.invalid/api/auth";
const origin = "https://workshop.example.invalid";
const email = `person-${randomBytes(4).toString("hex")}@example.invalid`;
const subject = `subject-${randomBytes(8).toString("hex")}`;
const clientId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519").privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "EdDSA", use: "sig" };
let claimsOverride = {}, discoveryOverride = {}, userinfoOverride = {}, keyOverride = null;
let idNonce, challenge, calls = 0, fallback = false, wrongSignature = false;
const jwt = () => {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "fixture" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: subject, aud: clientId, nonce: idNonce,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    ...(fallback ? {} : { email: email.toUpperCase(), email_verified: true }), ...claimsOverride })).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), wrongSignature ? otherKey : privateKey).toString("base64url")}`;
};

try {
  const fromShared=createRequire(join(upstream,"packages/workshop-shared/package.json"));
  const workerTypes=join(dirname(fromShared.resolve("@cloudflare/workers-types/package.json")),"experimental/index.d.ts");
  await writeFile(join(output,"env.d.ts"),`declare namespace Cloudflare { interface GlobalProps { mainModule: typeof import(${JSON.stringify(join(root,"src/index"))}); durableNamespaces: "OidcLogin"; } }`);
  await writeFile(join(output,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"ESNext",moduleResolution:"bundler",strict:true,skipLibCheck:true,noEmit:true,lib:["ESNext"],types:[workerTypes],paths:{
    "@gadgets/gatekeeper-kit/*":[join(upstream,"packages/gatekeeper-kit/src/*")],
    "@gadgets/workshop-shared/*":[join(upstream,"packages/workshop-shared/src/*")],
    "jose":[join(dirname(fromKit.resolve("jose")),"../types/index.d.ts")],
  }},include:[join(root,"src/**/*.ts"),join(output,"env.d.ts")]}));
  const types=spawnSync(join(upstream,"node_modules/.bin/tsc"),["-p",join(output,"tsconfig.json")],{encoding:"utf8"});
  assert.equal(types.status,0,types.stdout+types.stderr);
  await build({ stdin: { contents: `
import worker, { GatekeeperVendor, GatekeeperUserImpl, OidcLogin as BaseLogin } from ${JSON.stringify(join(root,"src/index.ts"))};
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
export { GatekeeperVendor, GatekeeperUserImpl };
export class Probe extends DurableObject {
  async save(email) { this.ctx.storage.kv.put('result', {email}); }
  async fetch() { return Response.json(this.ctx.storage.kv.get('result') ?? null); }
}
export class Callback extends WorkerEntrypoint {
  async complete(account) {
    if (this.ctx.props.delay) await new Promise(resolve => setTimeout(resolve, this.ctx.props.delay));
    const email = await account.getAuthenticatedEmail();
    await this.ctx.exports.Probe.get(this.ctx.exports.Probe.idFromName('result')).save(email);
    return {targetOrigin: ${JSON.stringify(origin)}, ticket: 'fixture-handoff-ticket'};
  }
}
export class OidcLogin extends BaseLogin {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if(path === '/expire') {
      const nonce = this.ctx.storage.kv.get('nonce');
      if(nonce) this.ctx.storage.kv.put('nonce', {...nonce, expiresAt: 0});
    }
    return Response.json({keys: [...(await this.ctx.storage.list()).keys()], email: await this.email()});
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/test/start') {
      try {
        const options = await request.json();
        const vendor = ctx.exports.GatekeeperVendor({});
        return Response.json(await vendor.connectAccount(ctx.exports.Callback({props:{delay:options.delay ?? 0}}),{scopes:options.scopes}));
      } catch (error) { return new Response(String(error), {status:400}); }
    }
    return worker.fetch(request,env,ctx);
  }
};`, resolveDir: root, sourcefile: "test-harness.ts", loader: "ts" },
    bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: join(output, "worker.mjs"),
    external: ["cloudflare:workers"], alias: { "@gadgets/gatekeeper-kit": join(upstream,"packages/gatekeeper-kit/src"),
      "jose": fromKit.resolve("jose") } });

  const bindings = { PUBLIC_BASE_URL: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: secret,
    OIDC_ALLOWED_IDENTITIES: JSON.stringify([{email,subject}]) };
  const options = { name: "oidc-check", modules: true, scriptPath: join(output,"worker.mjs"),
    compatibilityDate: "2026-10-04", compatibilityFlags: ["allow_irrevocable_stub_storage"],
    durableObjects: { OidcLogin: { className: "OidcLogin", useSQLite: true }, Probe: { className: "Probe", useSQLite: true } }, bindings,
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.href === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`, id_token_signing_alg_values_supported:["EdDSA"], code_challenge_methods_supported:["S256"], ...discoveryOverride });
      if (url.href === `${issuer}/jwks`) return Response.json({keys:keyOverride ?? [jwk]});
      if (url.href === `${issuer}/userinfo`) {
        assert.equal(request.headers.get("authorization"), "Bearer fixture-access-token");
        return Response.json({sub:subject,email,email_verified:true,...userinfoOverride});
      }
      assert.equal(url.href, `${issuer}/token`);
      calls++;
      const body = new URLSearchParams(await request.text());
      assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`);
      assert.equal(body.get("grant_type"),"authorization_code");
      assert.equal(body.get("redirect_uri"),`${origin}/gatekeeper/oidc/oauth`);
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"),challenge);
      return Response.json({access_token:"fixture-access-token",token_type:"Bearer",id_token:jwt()});
    } };
  const make = changes => new Miniflare(convertV4MiniflareOptions({...options,bindings:{...bindings,...changes}}));
  const mf = make({});
  const start = async (instance = mf,delay=0) => {
    const response = await instance.dispatchFetch(`${origin}/test/start`,{method:"POST",body:JSON.stringify({scopes:"auth",delay})});
    assert.equal(response.status,200,await response.clone().text());
    const {url} = await response.json();
    const begun = await instance.dispatchFetch(url,{redirect:"manual"});
    return {url,begun};
  };
  const authorize = async (instance = mf,delay=0) => {
    const attempt = await start(instance,delay);
    assert.equal(attempt.begun.status,302,await attempt.begun.clone().text());
    const authorization = new URL(attempt.begun.headers.get("location"));
    assert.equal(authorization.origin,new URL(issuer).origin);
    assert.equal(authorization.searchParams.get("scope"),"openid profile email");
    idNonce=authorization.searchParams.get("nonce"); challenge=authorization.searchParams.get("code_challenge");
    return {...attempt,authorization};
  };
  const callback = authorization => `${origin}/gatekeeper/oidc/oauth?${new URLSearchParams({code:"fixture-code",state:authorization.searchParams.get("state"),iss:issuer})}`;
  const complete = attempt => mf.dispatchFetch(callback(attempt.authorization));
  const inspect = async (attempt,path="/state") => {
    const namespace = await mf.getDurableObjectNamespace("OidcLogin");
    return (await namespace.get(namespace.idFromString(attempt.authorization.searchParams.get("state").split(":")[0])).fetch(`https://test.invalid${path}`)).json();
  };
  try {
    let attempt = await authorize();
    assert.equal((await mf.dispatchFetch(attempt.url)).status,400,"initiation replay");
    let result = await complete(attempt);
    assert.equal(result.status,200,await result.clone().text());
    const html = await result.text();
    assert.match(html,/fixture-handoff-ticket/);
    for(const value of ["fixture-access-token",secret,jwt(),email,subject]) assert.ok(!html.includes(value),"callback exposes no identity or provider credentials");
    const probe = await mf.getDurableObjectNamespace("Probe");
    assert.deepEqual(await (await probe.get(probe.idFromName("result")).fetch("https://test.invalid")).json(),{email});
    assert.deepEqual(await inspect(attempt),{keys:[],email:null},"transient identity removed after handoff");
    const count = calls;
    assert.equal((await complete(attempt)).status,400); assert.equal(calls,count,"no repeated code exchange");

    for (const claims of [{iss:"https://other.example.invalid"},{aud:"other-client"},{nonce:"wrong"},
      {exp:Math.floor(Date.now()/1000)-1},{iat:Math.floor(Date.now()/1000)+3600},{email_verified:false},
      {email:"not-allowed@example.invalid"},{sub:"wrong-subject"},{aud:[clientId,"another"],azp:"another"}]) {
      claimsOverride=claims; attempt=await authorize(); result=await complete(attempt);
      assert.equal(result.status,400,`rejected ${Object.keys(claims).join(",")}`);
      assert.deepEqual(await inspect(attempt),{keys:[],email:null});
    }
    claimsOverride={};
    attempt=await authorize(mf,2200); claimsOverride={exp:Math.floor(Date.now()/1000)+2};
    assert.equal((await complete(attempt)).status,200);
    assert.deepEqual(await (await probe.get(probe.idFromName("result")).fetch("https://test.invalid")).json(),{email:null},"expired identity cannot authorize Workshop session creation");
    assert.deepEqual(await inspect(attempt),{keys:[],email:null}); claimsOverride={};
    wrongSignature=true; attempt=await authorize(); assert.equal((await complete(attempt)).status,400); wrongSignature=false;
    keyOverride=[{...jwk,alg:"RS256"}]; attempt=await authorize(); assert.equal((await complete(attempt)).status,400); keyOverride=null;
    fallback=true; attempt=await authorize(); assert.equal((await complete(attempt)).status,200,"verified userinfo fallback");
    for(const profile of [{sub:"mismatch"},{email_verified:false},{email_verified:undefined}]) {
      userinfoOverride=profile; attempt=await authorize(); assert.equal((await complete(attempt)).status,400);
    }
    userinfoOverride={};fallback=false;
    attempt=await authorize(); const before=calls; await inspect(attempt,"/expire");
    assert.equal((await complete(attempt)).status,400); assert.equal(calls,before,"expired attempt never exchanges code");
    attempt=await authorize(); assert.equal((await mf.dispatchFetch(`${callback(attempt.authorization)}&state=duplicate`)).status,400);
    attempt=await authorize(); assert.equal((await mf.dispatchFetch(callback(attempt.authorization).replace(encodeURIComponent(issuer),encodeURIComponent("https://other.example.invalid")))).status,400);
    assert.equal((await complete(attempt)).status,400,"mismatched issuer consumes attempt");
    attempt=await authorize(); const denied=new URL(callback(attempt.authorization)); denied.searchParams.set("error","access_denied");
    assert.equal((await mf.dispatchFetch(denied)).status,400); assert.equal((await complete(attempt)).status,400);
    discoveryOverride={token_endpoint:"https://other.example.invalid/token"}; const failed=await start(); assert.equal(failed.begun.status,400); discoveryOverride={};
    assert.equal((await mf.dispatchFetch(`${origin}/test/start`,{method:"POST",body:JSON.stringify({scopes:"full"})})).status,400);
    for (const allowed of ["", "[]", JSON.stringify([{email,subject:""}])]) {
      const deniedInstance=make({OIDC_ALLOWED_IDENTITIES:allowed});
      try { assert.equal((await deniedInstance.dispatchFetch(`${origin}/test/start`,{method:"POST",body:'{"scopes":"auth"}'})).status,400); }
      finally { await deniedInstance.dispose(); }
    }
    const loginInstance=make({OIDC_LOGIN_URL:"https://login.example.invalid/sign-in",OIDC_LOGIN_SITE:"example"});
    try {
      const login=await start(loginInstance); const entry=new URL(login.begun.headers.get("location"));
      assert.equal(entry.origin,"https://login.example.invalid"); assert.equal(entry.searchParams.get("sitename"),"example");
      assert.equal(new URL(entry.searchParams.get("callbackURL")).origin,new URL(issuer).origin);
    } finally {await loginInstance.dispose();}
    console.log("OIDC native workerd checks passed: signed login, handoff cleanup, replay, PKCE, issuer/audience/nonce, verified email, subject allowlist, expiry and auth-only scope.");
  } finally { await mf.dispose(); }
} finally { await rm(output,{recursive:true,force:true}); }
