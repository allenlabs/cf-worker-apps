import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? 'cloudflare-os');
const failure = process.argv[3] ?? '';
assert(['', 'session', 'no-email', 'signups-disabled'].includes(failure), 'Unknown failure fixture');
const output = await mkdtemp(join(tmpdir(), 'cloud-agent-os-handoff-'));
const rootRequire = createRequire(join(source, 'package.json'));
const kitRequire = createRequire(join(source, 'packages/gatekeeper-kit/package.json'));
const googleRequire = createRequire(join(source, 'packages/gatekeeper-google/package.json'));
const wranglerRequire = createRequire(rootRequire.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = googleRequire('miniflare');
const origin = 'https://workshop.example.invalid';
const issuer = 'https://identity.example.invalid/api/auth';
const resource = 'https://resource.example.invalid';
const email = 'synthetic-person@example.invalid';
const subject = 'synthetic-subject';
const clientId = 'synthetic-client';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const expired = 'This sign-in attempt has expired. Please try again.';
const aliases = Object.fromEntries(['gatekeeper-kit', 'workshop-shared', 'observability', 'typed-storage', 'router'].map(name => [`@gadgets/${name}`, join(source, 'packages', name, 'src')]));
const options = { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'node:*'], alias: { ...aliases, jose: kitRequire.resolve('jose') } };

await build({ ...options, stdin: { contents: `
import gate, { GatekeeperVendor, GatekeeperUserImpl, OidcLogin as BaseOidcLogin } from ${JSON.stringify(join(source, 'packages/gatekeeper-oidc/src/index.ts'))};
export { GatekeeperVendor, GatekeeperUserImpl };
export class OidcLogin extends BaseOidcLogin {
  async email() { return this.env.TEST_NO_EMAIL ? null : super.email(); }
  async inspect() { return {keys:[...(await this.ctx.storage.list()).keys()], hasIdentity:!!(await this.authenticatedIdentity())}; }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/test/inspect') {
      const {id} = await request.json();
      return Response.json(await ctx.exports.OidcLogin.get(ctx.exports.OidcLogin.idFromString(id)).inspect());
    }
    return gate.fetch(request, env, ctx);
  }
};`, resolveDir: output, sourcefile: 'oidc-fixture.ts', loader: 'ts' }, outfile: join(output, 'oidc.mjs') });

await build({ ...options,
  plugins: [{ name: 'only-cloudflare-vendor-constant', setup(plugin) {
    plugin.onResolve({filter: /^\.\.\/user\.js$/}, args => args.importer.endsWith('/auth/login-flow.ts') ? { path: 'user-constant', namespace: 'fixture' } : undefined);
    plugin.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: 'export const CLOUDFLARE_VENDOR_ID = "cloudflare";', loader: 'js'}));
  } }],
  stdin: { contents: `
import { DurableObject } from 'cloudflare:workers';
import { PendingLogin as BasePendingLogin, LoginConnectCallbackImpl, EXPIRED_MESSAGE } from ${JSON.stringify(join(source, 'packages/workshop-backend/src/auth/login-flow.ts'))};
import { newSecretToken, hashPresentedSecret } from ${JSON.stringify(join(source, 'packages/workshop-backend/src/connect-handoff.ts'))};
export { LoginConnectCallbackImpl };
export class PendingLogin extends BasePendingLogin {
  async inspect() {
    const result = this.ctx.storage.kv.get('result');
    return { keys:[...(await this.ctx.storage.list()).keys()], outcome:!result?'absent':'pending' in result?'pending':'error' in result?'error':'consumed' in result?'consumed':'token', confirmed:result?.confirmed, expiresAt:result?.expiresAt, alarm:await this.ctx.storage.getAlarm() };
  }
  async expire() { const result=this.ctx.storage.kv.get('result'); if(result) this.ctx.storage.kv.put('result', {...result, expiresAt:0}); }
}
export class UserDurableObject extends DurableObject {
  async loginOrCreateViaGatekeeper(email, signupsEnabled, principal) {
    if(this.env.TEST_USER_FAILURE) throw new Error('Synthetic user login failure');
    if(this.env.TEST_SIGNUPS_DISABLED) return null;
    if(email!==${JSON.stringify(email)} || !signupsEnabled || principal?.issuer!==${JSON.stringify(issuer)} || principal?.subject!==${JSON.stringify(subject)} || principal?.email!==email) throw new Error('Fixture identity provenance mismatch');
    this.ctx.storage.kv.put('login', {email, signupsEnabled, principal});
    this.ctx.storage.kv.put('count', (this.ctx.storage.kv.get('count')??0)+1);
    return 'synthetic-session-secret';
  }
  async inspect() { return {login:this.ctx.storage.kv.get('login'), count:this.ctx.storage.kv.get('count')??0}; }
}
export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      const input = request.method === 'POST' ? await request.json() : {};
      if(path==='/start') {
        const {secret, hash}=await newSecretToken();
        const pendingId=ctx.exports.PendingLogin.idFromName(hash);
        const pending=ctx.exports.PendingLogin.get(pendingId);
        await pending.begin();
        const callback=ctx.exports.LoginConnectCallbackImpl({props:{pendingId:pendingId.toString(),vendorId:'oidc'}});
        const {url}=await env.OIDC_VENDOR.connectAccount(callback,{scopes:'auth'});
        return Response.json({url,nonce:secret.toHex()});
      }
      if(path==='/user') return Response.json(await ctx.exports.UserDurableObject.get(ctx.exports.UserDurableObject.idFromName(${JSON.stringify(email)})).inspect());
      const nonceHash=await hashPresentedSecret(input.nonce);
      if(nonceHash===undefined) throw new Error(EXPIRED_MESSAGE);
      const pending=ctx.exports.PendingLogin.get(ctx.exports.PendingLogin.idFromName(nonceHash));
      if(path==='/confirm') { await pending.confirm(input.ticket); return Response.json({ok:true}); }
      if(path==='/receive') return Response.json({token:await pending.receive()});
      if(path==='/inspect') return Response.json(await pending.inspect());
      if(path==='/expire') { await pending.expire(); return Response.json({ok:true}); }
      return new Response('Not found',{status:404});
    } catch(error) { return Response.json({error:error.message},{status:400}); }
  }
};`, resolveDir: output, sourcefile: 'workshop-fixture.ts', loader: 'ts' }, outfile: join(output, 'workshop.mjs') });

let tokenRequests = 0;
let expectedChallenge;
const common = { modules: true, compatibilityDate: '2026-10-04', compatibilityFlags: ['allow_irrevocable_stub_storage', 'nodejs_als'] };
const mf = new Miniflare(convertV4MiniflareOptions({ cf:false, rootPath:output, workers: [
  { ...common, name:'workshop', scriptPath:join(output,'workshop.mjs'), bindings:{PUBLIC_BASE_URL:origin, TEST_USER_FAILURE:failure==='session', TEST_SIGNUPS_DISABLED:failure==='signups-disabled'},
    kvNamespaces:['BLUEPRINTS'], durableObjects:{PendingLogin:{className:'PendingLogin',useSQLite:true}, UserDurableObject:{className:'UserDurableObject',useSQLite:true}},
    serviceBindings:{OIDC_VENDOR:{name:'oidc',entrypoint:'GatekeeperVendor'}} },
  { ...common, name:'oidc', scriptPath:join(output,'oidc.mjs'),
    durableObjects:{OidcLogin:{className:'OidcLogin',useSQLite:true}}, bindings:{TEST_NO_EMAIL:failure==='no-email', PUBLIC_BASE_URL:origin, OIDC_ISSUER:issuer, OIDC_CLIENT_ID:clientId,
      SIGN_IN_PROTOCOL:'oauth-jwt', OAUTH_JWT_RESOURCE:resource, OAUTH_JWT_SCOPES:'["profile","email"]', OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD:'none', OIDC_ALLOWED_IDENTITIES:JSON.stringify([{email,subject}])},
    outboundService:async request=>{
      const url=new URL(request.url);
      if(url.href==='https://identity.example.invalid/.well-known/oauth-authorization-server/api/auth') return Response.json({issuer, authorization_endpoint:issuer+'/authorize', token_endpoint:issuer+'/token', jwks_uri:issuer+'/jwks',response_types_supported:['code'], grant_types_supported:['authorization_code'], authorization_response_iss_parameter_supported:true,token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
      if(url.href===issuer+'/jwks') return Response.json({keys:[jwk]});
      assert.equal(url.href,issuer+'/token','no external network');
      const body=new URLSearchParams(await request.text());
      assert.equal(body.get('resource'),resource); assert.equal(body.get('client_id'),clientId);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),expectedChallenge);
      tokenRequests++;
      const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic'})).toString('base64url');
      const payload=Buffer.from(JSON.stringify({iss:issuer, sub:subject, email, emailVerified:true, banned:false, aud:resource, client_id:clientId,azp:clientId,token_use:'access',scope:'profile email',jti:'synthetic-jti',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
      return Response.json({access_token:header+'.'+payload+'.'+sign('sha256',Buffer.from(header+'.'+payload),privateKey).toString('base64url'),token_type:'Bearer'});
    } }
] }));

const results=[];
try {
  const workshop=await mf.getWorker('workshop');
  const oidc=await mf.getWorker('oidc');
  const post=async(path,input={})=>{
    const response=await workshop.fetch(origin+path,{method:'POST',body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  const call=async(path,input={},status=200)=>{
    const response=await post(path,input); assert.equal(response.status,status,JSON.stringify(response.body)); return response.body;
  };
  const attempt=await call('/start');
  assert.deepEqual(await call('/receive',{nonce:attempt.nonce}),{token:null});
  assert.equal((await call('/inspect',{nonce:attempt.nonce})).outcome,'pending');
  const begun=await oidc.fetch(attempt.url,{redirect:'manual'});
  assert.equal(begun.status,302,await begun.clone().text());
  const authorize=new URL(begun.headers.get('location'));
  expectedChallenge=authorize.searchParams.get('code_challenge');
  const callback=new URL(origin+'/gatekeeper/oidc/oauth');
  callback.searchParams.set('code','synthetic-code');callback.searchParams.set('state',authorize.searchParams.get('state'));callback.searchParams.set('iss',issuer);
  const completed=await oidc.fetch(callback.href);
  const html=await completed.text();
  const id=authorize.searchParams.get('state').split(':')[0];
  const cleaned=await (await oidc.fetch(origin+'/test/inspect',{method:'POST',body:JSON.stringify({id})})).json();
  assert.deepEqual(cleaned,{keys:[],hasIdentity:false});
  if(failure) {
    assert.equal(completed.status,502,'Failed Workshop callback must not emit successful handoff');
    assert.ok(html.includes('<h1>Sign-in failed (sign_in_handoff_failed)</h1>'));
    assert.ok(html.includes(`<a href="${origin}/" target="_blank" rel="noopener noreferrer">Restart sign-in</a>`));
    assert.equal(completed.headers.get('cache-control'),'no-store');
    assert.equal(completed.headers.get('referrer-policy'),'no-referrer');
    assert.equal(html.includes('<title>Connected</title>'),false);
    assert.equal((await call('/inspect',{nonce:attempt.nonce})).outcome,'error');
    const reason=failure==='no-email' ? "This account has no verified email, so it can't be used to sign in."
      : failure==='signups-disabled' ? 'New sign-ups are currently disabled on this deployment.'
      : 'Sign-in failed. Please try again.';
    assert.equal((await call('/receive',{nonce:attempt.nonce},400)).error,reason);
    assert.equal((await call('/inspect',{nonce:attempt.nonce})).outcome,'absent');
    assert.equal((await call('/receive',{nonce:attempt.nonce},400)).error,expired);
    assert.equal((await call('/user')).count,0);
    assert.equal(tokenRequests,1);
    console.log(JSON.stringify({passed:true,check:'failed Workshop callback returns fixed failure and preserves original-tab reason',failure}));
  } else {
  assert.equal(completed.status,200,html);
  const ticket=JSON.parse(/var ticket = ("[^"]+");/.exec(html)?.[1]??'null');
  assert.match(ticket,/^[0-9a-f]{64}$/);
  const delivered=await call('/inspect',{nonce:attempt.nonce});
  assert.equal(delivered.outcome,'token');assert.equal(delivered.confirmed,false);
  assert.deepEqual(await call('/receive',{nonce:attempt.nonce}),{token:null});
  const user=await call('/user');
  assert.deepEqual(user,{login:{email,signupsEnabled:true,principal:{issuer,subject,email}},count:1});
  await call('/confirm',{nonce:attempt.nonce,ticket:'0'.repeat(64)},400).then(v=>assert.equal(v.error,expired));
  await call('/confirm',{nonce:'1'.repeat(64),ticket},400).then(v=>assert.equal(v.error,expired));
  assert.equal((await call('/inspect',{nonce:attempt.nonce})).outcome,'token');
  await call('/confirm',{nonce:attempt.nonce,ticket});
  await call('/confirm',{nonce:attempt.nonce,ticket});
  const receives=await Promise.all(Array.from({length:5},()=>post('/receive',{nonce:attempt.nonce})));
  const successes=receives.filter(x=>x.status===200 && x.body.token===email+':synthetic-session-secret').length;
  const expiryErrors=receives.filter(x=>x.status===400 && x.body.error===expired).length;
  results.push({check:'actual OIDC to actual Workshop callback',passed:true,provenanceRecorded:user.count===1,gatekeeperStorageCleared:cleaned.keys.length===0});
  results.push({check:'concurrent receives',successes,expiryErrors});
  assert.equal(successes,1,'exactly one receive releases the token');
  assert.equal(expiryErrors,4,'every later receive reports Workshop expiry');
  const repeat=await call('/receive',{nonce:attempt.nonce},400);assert.equal(repeat.error,expired);
  // The first confirmation reached the server, but pretend its reply was lost until after receive.
  await call('/confirm',{nonce:attempt.nonce,ticket});
  const consumed=await call('/inspect',{nonce:attempt.nonce});
  assert.equal(consumed.outcome,'consumed');
  assert.equal(consumed.expiresAt,delivered.expiresAt,'receive never extends the delivery window');
  assert.equal(consumed.alarm,delivered.alarm,'receive keeps the original cleanup alarm');
  assert.equal((await call('/confirm',{nonce:attempt.nonce,ticket:'0'.repeat(64)},400)).error,expired);
  assert.equal((await call('/confirm',{nonce:'1'.repeat(64),ticket},400)).error,expired);
  assert.equal((await call('/confirm',{nonce:attempt.nonce,ticket:'not-a-ticket'},400)).error,expired);
  await call('/confirm',{nonce:attempt.nonce,ticket});
  await call('/expire',{nonce:attempt.nonce});
  assert.equal((await call('/confirm',{nonce:attempt.nonce,ticket},400)).error,expired);
  assert.equal((await call('/inspect',{nonce:attempt.nonce})).outcome,'absent');
  const another=await call('/start');
  await call('/expire',{nonce:another.nonce});
  assert.equal((await call('/receive',{nonce:another.nonce},400)).error,expired);
  assert.equal(tokenRequests,1);
  results.push({check:'lost confirmation reply retries after single-use receive until original expiry',passed:true});
  console.log(JSON.stringify({passed:true,tokenRequests,results},null,2));
  }
} finally { await mf.dispose(); await rm(output,{recursive:true,force:true}); }
