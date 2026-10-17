import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.argv[2] ?? process.env.CLOUDFLARE_OS_SOURCE ?? "cloudflare-os");
const providerService = process.argv[3] === "oauth-jwt-service";
const oauthJwt = process.argv[3] === "oauth-jwt" || providerService;
const fromUpstream = createRequire(join(upstream, "package.json"));
const fromGoogle = createRequire(join(upstream, "packages/gatekeeper-google/package.json"));
const fromKit = createRequire(join(upstream, "packages/gatekeeper-kit/package.json"));
const fromWrangler = createRequire(fromUpstream.resolve("wrangler/package.json"));
const { build } = fromWrangler("esbuild");
const { Miniflare, convertV4MiniflareOptions } = fromGoogle("miniflare");
const output = await mkdtemp(join(root, ".test-output-"));
const issuer = "https://identity.example.invalid/api/auth";
const origin = "https://workshop.example.invalid";
const resource = "https://resource.example.invalid";
const scopes = ["profile", "email"];
const metadata = oauthJwt ? `https://identity.example.invalid/.well-known/oauth-authorization-server/api/auth`
  : `${issuer}/.well-known/openid-configuration`;
const email = `person-${randomBytes(4).toString("hex")}@example.invalid`;
const subject = `subject-${randomBytes(8).toString("hex")}`;
const clientId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("hex");
const { publicKey, privateKey } = oauthJwt ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
const otherKey = (oauthJwt ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519")).privateKey;
const alg = oauthJwt ? "RS256" : "EdDSA";
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg, use: "sig" };
let claimsOverride = {}, discoveryOverride = {}, userinfoOverride = {}, keyOverride = null;
let headerOverride = {}, authMethod = "none", tokenType = "Bearer";
let signingKeyOverride = null;
let idNonce, challenge, calls = 0, fallback = false, wrongSignature = false;
let tokenFailure = null, providerFailure = null, malformedToken = false, providerResponse = null;
let outboundCalls = 0;
const providerCalls = [];
const privateFailure = "fixture-private-code-token-nonce-email-url-stack";
async function expectFailure(response, code, status = 400) {
  assert.equal(response.status, status, `HTTP status for ${code}`);
  assert.equal(await response.text(), `Sign-in failed (${code}). Restart sign-in from the application.`,
    `fixed, credential-free diagnostic for ${code}`);
}
const jwt = () => {
  const header = Buffer.from(JSON.stringify({ alg, kid: "fixture", ...headerOverride })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: subject,
    ...(oauthJwt ? { aud: resource, jti: "fixture-token-id", client_id: clientId, azp: clientId,
      token_use: "access", scope: scopes.join(" "), email: email.toUpperCase(), emailVerified: true, banned: false }
      : { aud: clientId, nonce: idNonce, ...(fallback ? {} : { email: email.toUpperCase(), email_verified: true }) }),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    ...claimsOverride })).toString("base64url");
  return `${header}.${payload}.${sign(oauthJwt ? "sha256" : null, Buffer.from(`${header}.${payload}`), wrongSignature ? otherKey : signingKeyOverride ?? privateKey).toString("base64url")}`;
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
  async save(email, identity, account) {
    this.ctx.storage.kv.put('result', {email, identity});
    this.ctx.storage.kv.put('account', account);
  }
  async fetch() {
    const result = this.ctx.storage.kv.get('result');
    const account = this.ctx.storage.kv.get('account');
    return Response.json(result ? {...result, remainingIdentity: await account.getAuthenticatedIdentity()} : null);
  }
}
export class Callback extends WorkerEntrypoint {
  async complete(account) {
    if (this.env.TEST_CALLBACK_FAILURE) throw new Error(${JSON.stringify(privateFailure)});
    if (this.ctx.props.delay) await new Promise(resolve => setTimeout(resolve, this.ctx.props.delay));
    const email = await account.getAuthenticatedEmail();
    const identity = await account.getAuthenticatedIdentity();
    await this.ctx.exports.Probe.get(this.ctx.exports.Probe.idFromName('result')).save(email, identity, account);
    return {targetOrigin: ${JSON.stringify(origin)}, ticket: 'fixture-handoff-ticket'};
  }
}
export class OidcLogin extends BaseLogin {
  async clear() {
    await super.clear();
    if (this.env.TEST_CLEAR_FAILURE) throw new Error(${JSON.stringify(privateFailure)});
  }
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

  const bindings = { PUBLIC_BASE_URL: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId,
    ...(oauthJwt ? { SIGN_IN_PROTOCOL: "oauth-jwt", OAUTH_JWT_RESOURCE: resource, OAUTH_JWT_SCOPES: JSON.stringify(scopes),
      OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD: "none" } : { OIDC_CLIENT_SECRET: secret }),
    OIDC_ALLOWED_IDENTITIES: JSON.stringify([{email,subject}]) };
  const provider = async request => {
      const url = new URL(request.url);
      providerCalls.push({url: url.href, method: request.method});
      if (providerService) assert.equal(request.headers.get("x-native-provider-service"), "true", "real provider Worker receives the binding request");
      assert([metadata, `${issuer}/token`, `${issuer}/jwks`, ...(!oauthJwt ? [`${issuer}/userinfo`] : [])].includes(url.href),
        "only canonical discovered provider endpoints are requested");
      if (providerFailure === url.href) return new Response(privateFailure, {status:503});
      if (providerResponse?.url === url.href) return new Response(providerResponse.body, providerResponse.init);
      if (url.href === metadata) return Response.json({ issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        ...(oauthJwt ? { response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
          authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none", "client_secret_post"] }
          : { userinfo_endpoint: `${issuer}/userinfo`, id_token_signing_alg_values_supported:["EdDSA"] }),
        code_challenge_methods_supported:["S256"], ...discoveryOverride });
      if (url.href === `${issuer}/jwks`) return Response.json({keys:keyOverride ?? [jwk]});
      if (url.href === `${issuer}/userinfo`) {
        assert.equal(oauthJwt, false, "OAuth JWT profile never calls userinfo");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-access-token");
        return Response.json({sub:subject,email,email_verified:true,...userinfoOverride});
      }
      assert.equal(url.href, `${issuer}/token`);
      calls++;
      const body = new URLSearchParams(await request.text());
      if (oauthJwt) {
        assert.equal(request.headers.get("authorization"), null, "OAuth JWT never uses Basic");
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("client_secret"), authMethod === "none" ? null : secret);
        assert.equal(body.getAll("resource").length, 1);
        assert.equal(body.get("resource"), resource, "same explicit resource in exchange");
      } else assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`);
      assert.equal(body.get("grant_type"),"authorization_code");
      assert.equal(body.get("redirect_uri"),`${origin}/gatekeeper/oidc/oauth`);
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"),challenge);
      if (tokenFailure) return Response.json({error:tokenFailure,error_description:privateFailure}, {status:401});
      return Response.json(oauthJwt ? { access_token: malformedToken ? privateFailure : jwt(), token_type: tokenType,
        refresh_token: "fixture-refresh-token", id_token: "ignored-id-token" }
        : {access_token:"fixture-access-token",token_type:"Bearer",id_token:malformedToken ? privateFailure : jwt()});
    };
  const denyOutbound = () => { outboundCalls++; return new Response(privateFailure, {status:503}); };
  const options = { name: "oidc-check", modules: true, scriptPath: join(output,"worker.mjs"),
    compatibilityDate: "2026-10-04", compatibilityFlags: ["allow_irrevocable_stub_storage"],
    durableObjects: { OidcLogin: { className: "OidcLogin", useSQLite: true }, Probe: { className: "Probe", useSQLite: true } },
    outboundService: providerService ? denyOutbound : provider };
  const make = changes => {
    const auth = {...options, bindings:{...bindings,...changes},
      ...(providerService && !Object.hasOwn(changes,"IDENTITY_PROVIDER")
        ? {serviceBindings:{IDENTITY_PROVIDER:"identity-provider-check"}} : {})};
    return new Miniflare(convertV4MiniflareOptions({cf:false,...(providerService ? {workers:[auth, {
      name:"identity-provider-check", modules:true, compatibilityDate:"2026-10-04",
      script:`export default { fetch(request,env) {
        request = new Request(request);
        request.headers.set("x-native-provider-service","true");
        return env.FIXTURE.fetch(request);
      } };`, serviceBindings:{FIXTURE:provider}, outboundService:denyOutbound,
    }]} : auth)}));
  };
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
    assert.equal(authorization.searchParams.get("scope"), oauthJwt ? scopes.join(" ") : "openid profile email");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("response_type"), "code");
    if (oauthJwt) {
      assert.equal(authorization.searchParams.getAll("resource").length, 1);
      assert.equal(authorization.searchParams.get("resource"), resource);
      assert.equal(authorization.searchParams.has("nonce"), false);
    }
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
    await expectFailure(await mf.dispatchFetch(attempt.url),"sign_in_attempt_expired");
    let result = await complete(attempt);
    assert.equal(result.status,200,await result.clone().text());
    const html = await result.text();
    assert.match(html,/fixture-handoff-ticket/);
    for(const value of ["fixture-access-token","fixture-refresh-token",secret,jwt(),email,subject]) assert.ok(!html.includes(value),"callback exposes no identity or provider credentials");
    const probe = await mf.getDurableObjectNamespace("Probe");
    assert.deepEqual(await (await probe.get(probe.idFromName("result")).fetch("https://test.invalid")).json(),
      {email,identity:{issuer,subject,email},remainingIdentity:null},
      "the handoff reads the exact verified identity; the cleared capability cannot reconstruct it");
    assert.deepEqual(await inspect(attempt),{keys:[],email:null},"transient identity removed after handoff");
    assert.deepEqual(providerCalls, [{url:metadata,method:"GET"}, {url:metadata,method:"GET"},
      {url:`${issuer}/token`,method:"POST"}, {url:`${issuer}/jwks`,method:"GET"}], "canonical metadata, token and JWKS request URLs");
    assert.equal(outboundCalls,0,"service-bound provider requests never use global outbound fetch");
    const count = calls;
    await expectFailure(await complete(attempt),"sign_in_attempt_expired"); assert.equal(calls,count,"no repeated code exchange");

    const invalidClaims = oauthJwt ? [
      {iss:"https://other.example.invalid"}, {iss:undefined}, {aud:"other-resource"}, {aud:undefined}, {aud:[resource]}, {aud:[resource,"another"]},
      {sub:"wrong-subject"}, {email:"not-allowed@example.invalid"}, {emailVerified:false}, {emailVerified:"true"},
      {emailVerified:undefined}, {email:undefined}, {email:42}, {sub:undefined}, {sub:42},
      {exp:Math.floor(Date.now()/1000)-1}, {exp:"123"}, {exp:1e300}, {exp:Number.MAX_SAFE_INTEGER}, {exp:1.5}, {exp:undefined},
      {iat:Math.floor(Date.now()/1000)+3600}, {iat:Math.floor(Date.now()/1000)-3600}, {iat:-1}, {iat:1.5}, {iat:"123"}, {iat:undefined},
      {exp:Math.floor(Date.now()/1000)+30, iat:Math.floor(Date.now()/1000)+45},
      {jti:undefined}, {jti:""}, {jti:42}, {client_id:"other"}, {client_id:undefined}, {azp:"other"}, {azp:undefined},
      {scope:"profile"}, {scope:["profile","email"]}, {scope:"profile\temail"}, {scope:undefined},
      {token_use:"id"}, {token_use:undefined}, {banned:true}, {banned:"false"}, {banned:undefined},
    ] : [{iss:"https://other.example.invalid"},{aud:"other-client"},{nonce:"wrong"},
      {exp:Math.floor(Date.now()/1000)-1},{iat:Math.floor(Date.now()/1000)+3600},{email_verified:false},
      {email:"not-allowed@example.invalid"},{sub:"wrong-subject"},{aud:[clientId,"another"],azp:"another"}];
    for (const claims of invalidClaims) {
      claimsOverride=claims; attempt=await authorize(); result=await complete(attempt);
      const code = oauthJwt ? claims.emailVerified === false || claims.emailVerified === "true" ? "verified_email_required"
        : claims.email === "not-allowed@example.invalid" || claims.sub === "wrong-subject" ? "identity_not_allowed"
        : claims.email === 42 || claims.sub === 42 || Object.hasOwn(claims,"jti") && claims.jti !== undefined ? "invalid_identity_response"
        : "invalid_identity_token"
        : claims.email_verified === false ? "verified_email_required"
          : claims.email || claims.sub ? "identity_not_allowed" : "invalid_identity_token";
      await expectFailure(result, code, ["verified_email_required", "identity_not_allowed"].includes(code) ? 403 : 400);
      assert.deepEqual(await inspect(attempt),{keys:[],email:null});
    }
    claimsOverride={};
    attempt=await authorize(mf,2200); claimsOverride={exp:Math.floor(Date.now()/1000)+2};
    assert.equal((await complete(attempt)).status,200);
    assert.deepEqual(await (await probe.get(probe.idFromName("result")).fetch("https://test.invalid")).json(),
      {email:null,identity:null,remainingIdentity:null},"expired identity cannot authorize Workshop session creation");
    assert.deepEqual(await inspect(attempt),{keys:[],email:null}); claimsOverride={};
    wrongSignature=true; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_token"); wrongSignature=false;
    keyOverride=[{...jwk,alg:oauthJwt ? "EdDSA" : "RS256"}]; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_keys"); keyOverride=null;
    malformedToken=true; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_token"); malformedToken=false;
    if (!oauthJwt) {
    fallback=true; attempt=await authorize(); assert.equal((await complete(attempt)).status,200,"verified userinfo fallback");
    assert.deepEqual(await (await probe.get(probe.idFromName("result")).fetch("https://test.invalid")).json(),
      {email,identity:{issuer,subject,email},remainingIdentity:null},"verified userinfo retains the signed subject and issuer");
    for(const profile of [{sub:"mismatch"},{email_verified:false},{email_verified:undefined}]) {
      userinfoOverride=profile; attempt=await authorize();
      await expectFailure(await complete(attempt), profile.sub ? "identity_subject_mismatch" : "verified_email_required", profile.sub ? 400 : 403);
    }
    userinfoOverride={};fallback=false;
    } else {
      for (const header of [{alg:"HS256"}, {alg:"none"}, {alg:"EdDSA"}, {kid:""}, {crit:["fixture"]},
        {jwk}, {jku:`${issuer}/jwks`}, {x5u:`${issuer}/keys`}, {x5c:["fixture"]}]) {
        headerOverride=header; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_token");
      }
      headerOverride={};
      for (const key of [{...jwk,kty:"oct",k:"fixture"}, {...jwk,d:""}, {...jwk,p:"private"},
        {...jwk,key_ops:["sign","verify"]}, {...jwk,use:"enc"}, {...jwk,n:"invalid"}]) {
        keyOverride=[key]; attempt=await authorize(); await expectFailure(await complete(attempt),
          key.n === "invalid" ? "invalid_identity_token" : "invalid_identity_keys");
      }
      keyOverride=[jwk,jwk]; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_keys");
      keyOverride=[jwk,{...jwk,d:"private"}]; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_keys");
      const weak=generateKeyPairSync("rsa",{modulusLength:1024}); signingKeyOverride=weak.privateKey;
      keyOverride=[{...weak.publicKey.export({format:"jwk"}),kid:"fixture",alg}];
      attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_token");
      keyOverride=null; signingKeyOverride=null;
      tokenType="DPoP"; attempt=await authorize(); await expectFailure(await complete(attempt),"invalid_identity_token"); tokenType="Bearer";
      attempt=await authorize(); const missing=new URL(callback(attempt.authorization)); missing.searchParams.delete("iss");
      const before=calls; await expectFailure(await mf.dispatchFetch(missing),"invalid_sign_in_callback");
      assert.equal(calls,before,"missing issuer never exchanges a code"); await expectFailure(await complete(attempt),"sign_in_attempt_expired");
      for (const metadata of [{authorization_response_iss_parameter_supported:false}, {code_challenge_methods_supported:["plain"]},
        {token_endpoint_auth_methods_supported:["client_secret_basic"]}, {grant_types_supported:["implicit"]},
        {grant_types_supported:null}, {grant_types_supported:"authorization_code"},
        {response_types_supported:["token"]}, {issuer:`${issuer}/other`}]) {
        discoveryOverride=metadata; await expectFailure((await start()).begun,"identity_provider_protocol_mismatch",502);
      }
      discoveryOverride={grant_types_supported:undefined};
      attempt=await authorize(); assert.equal((await complete(attempt)).status,200,"RFC 8414 defaults an omitted grant_types_supported to authorization_code and implicit");
      discoveryOverride={};
      authMethod="client_secret_post";
      const post=make({OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD:authMethod,OIDC_CLIENT_SECRET:secret});
      try { attempt=await authorize(post); assert.equal((await post.dispatchFetch(callback(attempt.authorization))).status,200); }
      finally { await post.dispose(); authMethod="none"; }
    }
    attempt=await authorize(); const before=calls; await inspect(attempt,"/expire");
    await expectFailure(await complete(attempt),"sign_in_attempt_expired"); assert.equal(calls,before,"expired attempt never exchanges code");
    attempt=await authorize(); assert.equal((await mf.dispatchFetch(`${callback(attempt.authorization)}&state=duplicate`)).status,400);
    attempt=await authorize(); assert.equal((await mf.dispatchFetch(callback(attempt.authorization).replace(encodeURIComponent(issuer),encodeURIComponent("https://other.example.invalid")))).status,400);
    assert.equal((await complete(attempt)).status,400,"mismatched issuer consumes attempt");
    attempt=await authorize(); const denied=new URL(callback(attempt.authorization)); denied.searchParams.set("error","access_denied");
    assert.equal((await mf.dispatchFetch(denied)).status,400); assert.equal((await complete(attempt)).status,400);
    discoveryOverride={token_endpoint:"https://other.example.invalid/token"}; const failed=await start();
    await expectFailure(failed.begun,"identity_provider_endpoint_mismatch",502); discoveryOverride={};
    for (const error of ["invalid_client", "invalid_grant", "invalid_verification", "identity_not_allowed", privateFailure]) {
      tokenFailure=error; attempt=await authorize();
      await expectFailure(await complete(attempt), error === "invalid_client" ? "token_client_rejected"
        : error === "invalid_grant" ? "token_grant_rejected" : "token_exchange_failed");
      assert.deepEqual(await inspect(attempt),{keys:[],email:null});
      const after=calls; await expectFailure(await complete(attempt),"sign_in_attempt_expired"); assert.equal(calls,after);
    }
    tokenFailure=null;
    if (providerService) {
      for (const [url, code, status] of [[metadata,"identity_provider_unavailable",502],
        [`${issuer}/token`,"token_exchange_failed",400], [`${issuer}/jwks`,"identity_provider_unavailable",502]]) {
        attempt=await authorize(); providerFailure=url;
        await expectFailure(await complete(attempt),code,status); providerFailure=null;
        assert.deepEqual(await inspect(attempt),{keys:[],email:null});
      }
      for (const [url, code, status] of [[metadata,"identity_provider_unavailable",502],
        [`${issuer}/token`,"token_exchange_failed",400], [`${issuer}/jwks`,"identity_provider_unavailable",502]]) {
        attempt=await authorize();
        providerResponse={url,body:privateFailure,init:{status:302,headers:{location:"https://other.example.invalid/steal"}}};
        await expectFailure(await complete(attempt),code,status); providerResponse=null;
      }
      for (const url of [metadata,`${issuer}/token`,`${issuer}/jwks`]) {
        attempt=await authorize(); providerResponse={url,body:"x".repeat(65537)};
        await expectFailure(await complete(attempt), url === metadata ? "identity_provider_unavailable"
          : url.endsWith("/token") ? "token_exchange_failed" : "invalid_identity_token", url === metadata ? 502 : 400);
        providerResponse=null;
      }
      const before=providerCalls.length;
      assert.equal((await mf.dispatchFetch(`${origin}/arbitrary?url=${encodeURIComponent(`${issuer}/token`)}`)).status,404);
      assert.equal(providerCalls.length,before,"inbound requests cannot route arbitrary provider calls");
      assert.equal(outboundCalls,0,"provider errors and redirects never fall back to global fetch");
      assert(providerCalls.every(call => [metadata,`${issuer}/token`,`${issuer}/jwks`].includes(call.url)),
        "redirect targets are never requested through the provider binding");
    }
    attempt=await authorize(); providerFailure=metadata;
    await expectFailure(await complete(attempt),"identity_provider_unavailable",502); providerFailure=null;
    assert.deepEqual(await inspect(attempt),{keys:[],email:null});
    for (const [binding, code] of [["TEST_CALLBACK_FAILURE","sign_in_handoff_failed"],["TEST_CLEAR_FAILURE","sign_in_cleanup_failed"]]) {
      const failureInstance=make({[binding]:true});
      try {
        const failureAttempt=await authorize(failureInstance);
        await expectFailure(await failureInstance.dispatchFetch(callback(failureAttempt.authorization)),code,502);
        const namespace=await failureInstance.getDurableObjectNamespace("OidcLogin");
        const id=namespace.idFromString(failureAttempt.authorization.searchParams.get("state").split(":")[0]);
        assert.deepEqual(await (await namespace.get(id).fetch("https://test.invalid/state")).json(),{keys:[],email:null});
      } finally { await failureInstance.dispose(); }
    }
    assert.equal((await mf.dispatchFetch(`${origin}/test/start`,{method:"POST",body:JSON.stringify({scopes:"full"})})).status,400);
    for (const allowed of ["", "[]", JSON.stringify([{email,subject:""}])]) {
      const deniedInstance=make({OIDC_ALLOWED_IDENTITIES:allowed});
      try { assert.equal((await deniedInstance.dispatchFetch(`${origin}/test/start`,{method:"POST",body:'{"scopes":"auth"}'})).status,400); }
      finally { await deniedInstance.dispose(); }
    }
    for (const invalid of [null, {}, "identity-provider-check", {fetch:"invalid"}]) {
      const invalidInstance=make({IDENTITY_PROVIDER:invalid});
      try {
        const before=providerCalls.length;
        const rejected=await invalidInstance.dispatchFetch(`${origin}/test/start`,{method:"POST",body:'{"scopes":"auth"}'});
        assert.equal(rejected.status,400);
        assert.equal(await rejected.text(),"Error: invalid_sign_in_configuration");
        assert.equal(providerCalls.length,before,"malformed provider binding is rejected before requests");
      } finally { await invalidInstance.dispose(); }
    }
    const loginInstance=make({OIDC_LOGIN_URL:"https://login.example.invalid/sign-in",OIDC_LOGIN_SITE:"example"});
    try {
      const login=await start(loginInstance); const entry=new URL(login.begun.headers.get("location"));
      assert.equal(entry.origin,"https://login.example.invalid"); assert.equal(entry.searchParams.get("sitename"),"example");
      assert.equal(new URL(entry.searchParams.get("callbackURL")).origin,new URL(issuer).origin);
    } finally {await loginInstance.dispose();}
    console.log(`${oauthJwt ? "OAuth JWT RS256" : "OIDC EdDSA"}${providerService ? " service binding" : ""} native workerd checks passed: signed login, fixed RPC failure categories/statuses, credential-free token/JWT/handoff/cleanup failures, replay, PKCE, issuer/audience, verified email, subject allowlist, expiry and auth-only scope.`);
  } finally { await mf.dispose(); }
} finally { await rm(output,{recursive:true,force:true}); }
