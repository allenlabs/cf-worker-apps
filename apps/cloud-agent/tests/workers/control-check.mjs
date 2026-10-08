import { piTextModules } from "./pi-modules.mjs";
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Reviewer-owned integration check. All credentials are generated fixtures.
// Authentication fixture bypasses OAuth only to isolate concurrency/CSRF;
// the separate admin-check exercises actual EdDSA and OIDC rejection cases.
const base = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(base, '../../build/pi/index.js');
const expected = process.argv[2];
if (expected !== undefined) assert.match(expected, /^[a-f0-9]{64}$/, 'Pass the frozen Worker bundle SHA256');
const actual = createHash('sha256').update(await readFile(bundle)).digest('hex');
if (expected !== undefined) assert.equal(actual, expected, 'Worker bundle changed after review freeze');
const temp = await mkdtemp(join(tmpdir(), 'cloud-agent-review-'));
const session = randomBytes(32).toString('base64url');
const csrf = randomBytes(32).toString('base64url');
const bearer = randomBytes(32).toString('base64url');
const wrapping = randomBytes(32).toString('base64url');
const origin = 'https://cloud-agent.example.invalid';
const hash = value => createHash('sha256').update(value).digest('hex');
await copyFile(bundle, join(temp, 'index.js'));
const textModules = await piTextModules(resolve(base, '../../build/pi'), temp);
await writeFile(join(temp, 'wrapper.js'), `
import worker, {Assistant as BaseAssistant, Credentials as BaseCredentials} from './index.js';
export default worker;
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export class Assistant extends BaseAssistant {
  constructor(ctx,env){
    const fault={armed:false};
    const wrap=db=>({prepare:sql=>{
      if(!sql.startsWith('UPDATE ca_streams SET kind='))return db.prepare(sql);
      return {bind:(...args)=>{const statement=db.prepare(sql).bind(...args);return {run:async()=>{if(fault.armed){fault.armed=false;throw Error('fixture_projection_unavailable');}return statement.run();}};}};
    },batch:list=>db.batch(list),withSession:constraint=>wrap(db.withSession(constraint))});
    super(ctx,{...env,CONVERSATIONS:wrap(env.CONVERSATIONS)});this.projectionFault=fault;
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/admit')return Response.json(await this.acceptChannel(await request.json()));
    if(path==='/state'){await this.lifecycle.start();return Response.json({...await this.channelHistory(),modelCalls:this.faux.state.callCount,queue:await this.getQueues(),pending:await this.harness.pending()});}
    if(path==='/workflow'){const {name}=await request.json();const snapshot=await this.operationSnapshot();return Response.json(await this.ask('Use the requested workflow skill.', 'workflow-'+name, {...snapshot,skillName:name,skillRevision:(await this.env.Credentials.getByName('owner').skillManifest(snapshot.manifestVersion)).skills.find(skill=>skill.name===name)?.version,skillAutomatic:true}));}
    if(path==='/usage'){await this.lifecycle.start();await this.publishUsage();return Response.json(await (await this.harness.pi()).usage(this.piContext));}
    if(path==='/resolve-account'){try{await this.env.Credentials.getByName(this.runtime().accountId).access();return Response.json({accountId:this.runtime().accountId,connected:true});}catch(error){return Response.json({accountId:this.runtime().accountId,error:error.message});}}
    if(path==='/fail-projection'){this.projectionFault.armed=true;return Response.json({armed:true});}
    if(path==='/projection'){const row=await this.env.CONVERSATIONS.prepare('SELECT metadata FROM ca_streams WHERE tenant_id=? AND object_key=?').bind('default',this.conversationKey()).first();return Response.json(JSON.parse(row.metadata));}
    if(path==='/busy-ledger'){
      const event=await request.json();
      const operationId='ctm-'+await hash(JSON.stringify(['sample-channel','sample-group',event.data.message_id]));
      this.channelSql.exec("INSERT INTO channel_messages (messageId,eventId,operationId,data,state,updatedAt) VALUES (?,?,?,?, 'accepted',?)",event.data.message_id,event.eventId,operationId,JSON.stringify({...event,rootMessageId:event.data.root_message_id}),Date.now());
      return Response.json({ok:true});
    }
    if(path==='/clear-busy'){this.channelSql.exec("DELETE FROM channel_messages WHERE messageId='review-orphan'");return Response.json({ok:true});}
    if(path==='/applied-admin-gap'){
      await this.lifecycle.start();const body=await request.json();
      this.channelSql.exec("INSERT INTO admin_controls (operationId,request,state,updatedAt) VALUES (?,?,'running',?)",body.operationId,JSON.stringify(['new','']),Date.now());
      const created=await this.harness.sessions.create();const runtime=this.runtime();runtime.sessionId=created.id;this.saveRuntime(runtime);
      return Response.json({selected:created.id,sessions:(await this.harness.sessions.list()).length});
    }
    return new Response('Not found',{status:404});
  }
}
export class Credentials extends BaseCredentials {
  async channelAccess(){return 'review-native-access';}
  async configureAccount(value) {
    // A real cross-actor request can overlap another owner mutation.
    await new Promise(resolve => setTimeout(resolve, 80));
    return super.configureAccount(value);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/seed') {
      const value = await request.json();
      const expiresAt = Date.now()+3600000;
      await this.ctx.storage.put('adminSession:'+await hash(value.session), {expiresAt, sealed:await this.seal({principal:{issuer:this.env.SSO_ISSUER,subject:'review-admin',email:'admin-one@example.invalid',role:'super_admin'},csrf:value.csrf})});
      await this.ctx.storage.put('credential',await this.seal({access:'review-access',refresh:'review-refresh',expiresAt,scopes:['resource.invoke','chatgpt.tokens.use.direct'],clientId:'review-client'}));
      await this.ctx.storage.put('registration',{subjectHash:'review-subject-hash',accountHash:null,plan:null,personalProConfirmed:true,clientId:'review-client'});
      return Response.json({ok:true});
    }
    if(path==='/seed-account'){
      const value=await request.json();const expiresAt=Date.now()+3600000;
      await this.ctx.storage.put('credential',await this.seal({access:'review-account-access',refresh:'review-account-refresh',expiresAt,scopes:['resource.invoke','chatgpt.tokens.use.direct'],clientId:'review-account-client'}));
      await this.ctx.storage.put('registration',{subjectHash:'review-account-subject',accountHash:null,planUsageConfirmed:true,clientId:'review-account-client'});
      await this.ctx.storage.put('identity',await this.seal({source:'verified_id_token',email:value.email,name:'Fixture account',planType:'business',accountId:'fixture-workspace',workspace:null,organizations:null,verifiedAt:new Date().toISOString()}));
      return Response.json({ok:true});
    }
    if(path==='/storage-check'){
      const identity=await this.ctx.storage.get('identity');return Response.json({identityEncrypted:identity?typeof identity.iv==='string'&&typeof identity.ciphertext==='string'&&!('email'in identity):null,cursor:await this.ctx.storage.get('accountCursor')??0,status:await this.status()});
    }
    if(path==='/report-usage')return Response.json(await this.reportUsage(await request.json()));
    return new Response('Not found',{status:404});
  }
}
`);
const writes=[];
const options = () => convertV4MiniflareOptions({
  resourcePersistencePath: join(temp, 'storage'),
  workers: [{
    name: 'cloud-agent', d1Databases: ['CONVERSATIONS'], modulesRoot: temp,
    modules: [...['wrapper.js', 'index.js'].map(name => ({ type: 'ESModule', path: join(temp, name) })), ...textModules],
    compatibilityDate: '2026-10-04', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { Assistant: { className: 'Assistant', useSQLite: true }, Credentials: { className: 'Credentials', useSQLite: true } },
    bindings: { ALLOWED_CHANNEL_ID: 'sample-channel', ALLOWED_CHAT_ID: 'sample-group', CHANNEL_APP_ID: 'sample-app', TOKEN_WRAPPING_AAD: 'fixture-cloud-agent/v1', PROBE_MODE: 'mock', OPENAI_MODEL: 'gpt-6.1-sol', PRODUCT_NAME: 'Fixture Cloud Agent', PUBLIC_ORIGIN: origin, SSO_ISSUER: 'https://sso.example.invalid/auth', SUPER_ADMIN_EMAILS: '["admin-one@example.invalid","admin-two@example.invalid"]', PROBE_KEY_SHA256: hash(bearer), DIAGNOSTIC_READS_ENABLED: 'true', TOKEN_WRAPPING_KEY: wrapping, CHANNEL_REPLY_ENABLED: 'true' },
    outboundService: async request => {
      assert.equal(request.url,'https://app-store-api.channel.io/general/v1/native/functions');assert.equal(request.method,'PUT');
      assert.equal(request.headers.get('x-access-token'),'review-native-access');
      const body=await request.json();assert.equal(body.method,'writeGroupMessage');assert.equal(body.params.channelId,'sample-channel');assert.equal(body.params.groupId,'sample-group');assert.ok(['review-root','review-rr-a','review-rr-b','review-rr-c','review-rr-d','review-fixed-retry'].includes(body.params.rootMessageId));assert.equal(body.params.broadcast,false);
      writes.push(body.params);return Response.json({result:{message:{id:'review-bot-'+writes.length}}});
    }
  }]
});
let mf = new Miniflare(options());
const api = async (path, body, extra = {}) => mf.dispatchFetch(origin + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { cookie: '__Host-cloud_agent_session=' + session, ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': csrf }), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const json = async r => { const text = await r.text(); assert.equal(r.status, 200, text); return JSON.parse(text); };
const event = (messageId,text,root='review-root') => ({name:'channel.message.created',eventId:'review-'+messageId,timestamp:new Date().toISOString(),data:{channel_id:'sample-channel',chat_id:'sample-group',message_id:messageId,root_message_id:root,is_thread_message:messageId!==root,is_root:messageId===root,sender_type:'manager',sender_id:'review-manager',text}});
const assistant=async(root='review-root')=>{const ns=await mf.getDurableObjectNamespace('Assistant','cloud-agent');return ns.get(ns.idFromName('channel-'+hash(JSON.stringify(['sample-channel','sample-group',root]))));};
const state=async(root='review-root')=>json(await (await assistant(root)).fetch('https://review.invalid/state'));
const admit=async(messageId,text,root='review-root')=>{await json(await (await assistant(root)).fetch('https://review.invalid/admit',{method:'POST',body:JSON.stringify(event(messageId,text,root))}));const deadline=Date.now()+12000;while(Date.now()<deadline){const value=await state(root);if(value.receipts.find(row=>row.messageId===messageId)?.state==='sent')return value;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Reviewer receipt did not settle: '+messageId);};
const control=(action,args='',operationId='admin-'+randomUUID(),root='review-root')=>api('/api/threads/control',{root,action,args,operationId});
const credential=async(id='owner')=>{const ns=await mf.getDurableObjectNamespace('Credentials','cloud-agent');return ns.get(ns.idFromName(id));};
const credentialState=async(id='owner')=>json(await (await credential(id)).fetch('https://review.invalid/storage-check'));
try {
  const ns = await mf.getDurableObjectNamespace('Credentials', 'cloud-agent');
  await json(await ns.get(ns.idFromName('owner')).fetch('https://review.invalid/seed', { method: 'POST', body: JSON.stringify({ session, csrf }) }));
  const anonymous = await mf.dispatchFetch(origin + '/api/overview');
  assert.equal(anonymous.status, 401);
  const nonCanonical = await mf.dispatchFetch('https://old-worker.workers.dev/api/overview', { headers: { cookie: '__Host-cloud_agent_session=' + session } });
  assert.equal(nonCanonical.status, 421);
  const legacyMutation = await mf.dispatchFetch(origin + '/api/accounts/create', { method: 'POST', headers: { origin, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify({ expectedEmail: 'bad@example.invalid' }) });
  assert.ok([401, 403].includes(legacyMutation.status), 'Legacy bearer unexpectedly authorized an admin mutation');
  assert.equal((await api('/api/accounts/create', { expectedEmail: 'bad@example.invalid' }, { origin: 'https://evil.example.invalid' })).status, 403);
  assert.equal((await api('/api/accounts/create', { expectedEmail: 'bad@example.invalid' }, { 'x-csrf-token': 'wrong' })).status, 403);
  const count = 8;
  const created = await Promise.all(Array.from({ length: count }, (_, n) => api('/api/accounts/create', { expectedEmail: 'parallel' + n + '@example.invalid' }).then(json)));
  const overview = await json(await api('/api/overview'));
  assert.equal(overview.accounts.length, count + 1, 'Concurrent account creation lost inventory entries');
  assert.deepEqual(new Set(overview.accounts.map(a => a.id)), new Set(['owner', ...created.map(a => a.id)]));
  const skills = Array.from({ length: 4 }, (_, n) => ({ rawContent: '---\nname: parallel-' + n + '\ndescription: Concurrent review fixture ' + n + '\n---\nReturn a short review answer.', resources: [] }));
  await Promise.all(skills.map(value => api('/api/skills/publish', value).then(json)));
  let afterSkills = await json(await api('/api/overview'));
  assert.equal(afterSkills.skills.length, 4, 'Concurrent skill publication lost catalog entries');
  await Promise.all(afterSkills.skills.map(value => api('/api/skills/toggle', { name: value.name, enabled: true }).then(json)));
  afterSkills = await json(await api('/api/overview'));
  assert.ok(afterSkills.skills.every(skill => skill.enabled), 'Concurrent skill toggles lost an enabled flag');
  assert.equal((await api('/api/skills/publish', { rawContent: skills[0].rawContent, resources: [{ path: 'references/../secret.txt', kind: 'reference', content: 'bad' }] })).status, 400);
  assert.equal((await api('/api/skills/publish', { rawContent: skills[0].rawContent, resources: [{ path: 'references/run.py', kind: 'file', content: 'print(1)' }] })).status, 400);
  assert.equal((await api('/api/accounts/disconnect', { id: 'owner', confirmed: false })).status, 400);
  let root=await admit('review-root','/ai 도움말');
  assert.equal(root.modelCalls,0);assert.equal(root.selected.sessionId,'1');
  assert.ok(root.receipts.at(-1).answer.includes('/ai 창'));assert.ok(root.receipts.at(-1).answer.includes('직원 기본값'));assert.ok(!root.receipts.at(-1).answer.includes('/ai new'));
  for(const [index,text] of ['/ai new','/ai resume 1','/ai compact','/ai skill:parallel-0 apply','/ai settings','/ai skills','/ai logout'].entries()){
    root=await admit('review-blocked-'+index,text);assert.equal(root.modelCalls,0);assert.equal(root.selected.sessionId,'1');assert.equal(root.sessions.length,1);assert.ok(root.receipts.at(-1).answer.includes(origin));
  }
  for(const [index,text] of ['/ai 모델','/ai 생각','/ai 생각 높음'].entries()){
    root=await admit('review-public-'+index,text);assert.equal(root.modelCalls,0);assert.ok(!/구독 계정:|세션:|스킬:/.test(root.receipts.at(-1).answer));
  }
  assert.equal((await json(await api('/api/threads/settings?root=review-root'))).thinking.value,'high');
  const newId='admin-'+randomUUID();
  await json(await (await assistant()).fetch('https://review.invalid/fail-projection'));
  const projectionFailed=await control('new','',newId);assert.equal(projectionFailed.status,400);assert.equal((await projectionFailed.json()).error,'admin_control_failed');
  const mutated=await state();assert.notEqual(mutated.selected.sessionId,'1');assert.equal(mutated.sessions.length,2);
  assert.equal((await json(await (await assistant()).fetch('https://review.invalid/projection'))).selectedSessionId,'1');
  const newControl=await json(await control('new','',newId));assert.equal(newControl.status,'done');const selected=newControl.settings.selected.sessionId;assert.equal(selected,mutated.selected.sessionId);assert.equal(newControl.settings.sessions.length,2);
  assert.equal((await json(await (await assistant()).fetch('https://review.invalid/projection'))).selectedSessionId,selected,'Done replay did not repair the D1 projection');
  const duplicate=await json(await control('new','',newId));assert.equal(duplicate.settings.selected.sessionId,selected);assert.equal(duplicate.settings.sessions.length,2);
  assert.equal((await control('name','different',newId)).status,400);
  await json(await (await assistant()).fetch('https://review.invalid/busy-ledger',{method:'POST',body:JSON.stringify(event('review-orphan','Accepted before native job repair'))}));
  assert.equal((await control('new')).status,409,'Ledger-only pending message unexpectedly allowed session mutation');
  await json(await (await assistant()).fetch('https://review.invalid/clear-busy'));
  const interruptedId='admin-'+randomUUID();const applied=await json(await (await assistant()).fetch('https://review.invalid/applied-admin-gap',{method:'POST',body:JSON.stringify({operationId:interruptedId})}));
  await mf.dispose();
  mf = new Miniflare(options());
  const restarted = await json(await api('/api/overview'));
  assert.equal(restarted.accounts.length, count + 1);
  assert.equal(restarted.accounts.find(a => a.id === 'owner').connected, true, 'Preserved owner grant disappeared after restart');
  assert.equal(restarted.skills.length, 4);
  assert.ok(restarted.skills.every(skill => skill.enabled));
  const recovered=await json(await control('new','',interruptedId));assert.equal(recovered.status,'uncertain');assert.equal(recovered.settings.selected.sessionId,applied.selected);assert.equal(recovered.settings.sessions.length,applied.sessions);
  const sameAgain=await json(await control('new','',interruptedId));assert.equal(sameAgain.status,'uncertain');assert.equal(sameAgain.settings.sessions.length,applied.sessions);
  assert.deepEqual(restarted.accountSelection,{mode:'fixed',defaultAccountId:'owner',poolAccountIds:[]},'Round robin became enabled implicitly');
  assert.equal(restarted.accounts.find(a=>a.id==='owner').identity,null,'Legacy account was assigned invented metadata');
  const account=created[0].id;
  const seedAccount=()=>credential(account).then(stub=>stub.fetch('https://review.invalid/seed-account',{method:'POST',body:JSON.stringify({email:'parallel0@example.invalid'})})).then(json);
  await seedAccount();
  const seededAccount=await credentialState(account);assert.equal(seededAccount.identityEncrypted,true);assert.equal(seededAccount.status.identity.planType,'business');assert.equal(seededAccount.status.identity.workspace,null);assert.equal(seededAccount.status.identity.organizations,null);
  assert.equal((await api('/api/accounts/default',{id:created[1].id})).status,409,'Disconnected default account was accepted');
  const selection={mode:'round_robin',defaultAccountId:'owner',poolAccountIds:['owner',account]};
  await json(await api('/api/accounts/selection',selection));
  const twins=await Promise.all(['review-rr-a','review-rr-b'].map(root=>admit(root,'/ai 도움말',root)));
  assert.deepEqual(new Set(twins.map(value=>value.selected.accountId)),new Set(['owner',account]),'Concurrent roots did not allocate distinct round-robin slots');
  assert.equal((await credentialState()).cursor,0);
  const third=await admit('review-rr-c','/ai 도움말','review-rr-c');assert.equal(third.selected.accountId,'owner');assert.equal((await credentialState()).cursor,1);
  await admit('review-rr-c','/ai 도움말','review-rr-c');assert.equal((await credentialState()).cursor,1,'Duplicate event consumed a second allocation');
  await json(await api('/api/accounts/selection',selection));assert.equal((await credentialState()).cursor,1,'Same policy retry reset the cursor');
  const fourth=await admit('review-rr-d','/ai 도움말','review-rr-d');assert.equal(fourth.selected.accountId,account);assert.equal((await state()).selected.accountId,'owner','Existing root changed accounts');
  const tokenFields=usage=>Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens','reasoning'].filter(field=>usage?.[field]!==undefined).map(field=>[field,usage[field]]));
  const manualId='manual-review-'+randomUUID(),manualPrompt={prompt:'One short fixture answer',operationId:manualId};
  const manualPath='/ask?thread=manual-test&account='+account;
  assert.equal((await json(await api(manualPath,manualPrompt))).status,'done');
  const manualUsage=(await credentialState(account)).status.usage;assert.equal(manualUsage.source,'pi_committed_usage');assert.ok(manualUsage.totalTokens>0);assert.equal(manualUsage.quota,null);assert.ok(!('cost'in manualUsage)&&!('requests'in manualUsage));
  await json(await api(manualPath,manualPrompt));assert.deepEqual(tokenFields((await credentialState(account)).status.usage),tokenFields(manualUsage),'Duplicate inference operation doubled usage');
  assert.equal((await credentialState()).status.usage,null,'Non-owner manual inference was attributed to owner');
  const nativeRoot=['review-rr-a','review-rr-b'][twins.findIndex(value=>value.selected.accountId===account)];
  await admit('review-native-usage','Count only newly committed native work',nativeRoot);
  const beforeFork=tokenFields((await credentialState(account)).status.usage);
  const settings=await json(await api('/api/threads/settings?root='+nativeRoot));assert.ok(settings.userEntries.length>0);
  await json(await control('clone','','admin-'+randomUUID(),nativeRoot));await json(await (await assistant(nativeRoot)).fetch('https://review.invalid/usage'));
  assert.deepEqual(tokenFields((await credentialState(account)).status.usage),beforeFork,'Native clone copied usage into measured totals');
  await json(await control('resume',settings.selected.sessionId,'admin-'+randomUUID(),nativeRoot));
  await json(await control('fork',String(settings.userEntries[0].id),'admin-'+randomUUID(),nativeRoot));await json(await (await assistant(nativeRoot)).fetch('https://review.invalid/usage'));
  assert.deepEqual(tokenFields((await credentialState(account)).status.usage),beforeFork,'Native entry fork copied historical usage');
  const snapshot={sourceId:hash('review-absolute-usage'),usage:{input:10,output:3,cacheRead:2,cacheWrite:0,totalTokens:15,reasoning:1}};
  const report=value=>credential(account).then(stub=>stub.fetch('https://review.invalid/report-usage',{method:'POST',body:JSON.stringify(value)})).then(json);
  await report(snapshot);const reported=tokenFields((await credentialState(account)).status.usage);await report(snapshot);assert.deepEqual(tokenFields((await credentialState(account)).status.usage),reported);
  assert.equal((await report({...snapshot,usage:{...snapshot.usage,input:9,totalTokens:14}})).accepted,false);assert.deepEqual(tokenFields((await credentialState(account)).status.usage),reported,'Older snapshot reduced totals');
  await json(await api('/api/accounts/default',{id:account}));await json(await api('/api/accounts/disconnect',{id:account,confirmed:true}));
  assert.equal((await admit('review-disconnected-help','/ai 도움말',nativeRoot)).selected.accountId,account,'Existing root pin changed after disconnect');
  const resolved=await json(await (await assistant(nativeRoot)).fetch('https://review.invalid/resolve-account'));assert.deepEqual(resolved,{accountId:account,error:'login_required'},'Disconnected pin resolved another account');
  let failedAdmission=false;
  try{const response=await (await assistant('review-fixed-retry')).fetch('https://review.invalid/admit',{method:'POST',body:JSON.stringify(event('review-fixed-retry','/ai 도움말','review-fixed-retry'))});failedAdmission=!response.ok;}catch{failedAdmission=true;}
  assert.equal(failedAdmission,true,'New fixed root was accepted with a disconnected account');
  await seedAccount();assert.equal((await admit('review-fixed-retry','/ai 도움말','review-fixed-retry')).selected.accountId,account,'Admission retry changed fixed account');
  await mf.dispose();mf=new Miniflare(options());
  assert.equal((await state(nativeRoot)).selected.accountId,account);assert.equal((await state()).selected.accountId,'owner');assert.equal((await credentialState(account)).identityEncrypted,true);
  assert.deepEqual(tokenFields((await credentialState(account)).status.usage),reported,'Usage totals disappeared after isolate restart');
  const workflowNames = ["announcement-review", "staff-request-triage", "staff-handoff"];
  for (const name of workflowNames) {
    const rawContent = await readFile(resolve(base, `../../skills/workflows/${name}/SKILL.md`), "utf8");
    const published = await json(await api("/api/skills/publish", { rawContent, resources: [] }));
    assert.equal(published.catalog.find(row => row.name === name).enabled, false);
    await json(await api("/api/skills/toggle", { name, enabled: true }));
    const output = await json(await (await assistant()).fetch("https://review.invalid/workflow", { method: "POST", body: JSON.stringify({ name }) }));
    assert.equal(output.status, "done");
    assert.equal(output.text, "MOCK_SKILL_OK");
    const transcript = JSON.stringify(output.entries);
    assert.ok(transcript.includes('"name":"activate_skill"') && transcript.includes('"name":"' + name + '"'), "Workflow was not activated through the native skill tool");
    assert.ok(transcript.includes(rawContent.split("---")[2].trim().split(/\r?\n/)[0]), "Workflow body was not loaded");
  }
  console.log(JSON.stringify({ checks: 'PASS', reviewer: 'independent', runtime: 'workerd', bundleSHA256: actual, concurrentAccountCreates: count, concurrentSkillPublications: skills.length, csrfAndCanonicalOrigin: true, legacyBearerMutationDenied: true, ownerGrantPreservedAfterRestart: true, skillStatePreservedAfterRestart: true, scriptAndTraversalDenied: true, staffHelpModelThinkingOnly: true, staffAdvancedWithoutInferenceOrMutation: true, actualRuntimeAdminIdempotencyAndConflict: true, doneAdminReplayRepairsProjectionWithoutMutation: true, ledgerOnlyPendingBusy409: true, interruptedAdminDoesNotRepeat: true, explicitRoundRobinConcurrentRoots: true, duplicateAndPolicyRetryPreserveCursor: true, fixedAdmissionRetryAndImmutablePins: true, disconnectedPinDoesNotResolveOtherAccount: true, encryptedMetadataNullLegacy: true, actualNativeUsageNoDoubleCountOnRetryCloneFork: true, usageAbsoluteMonotonicAccountIsolatedAndPersistent: true, mockChannelReplies: writes.length, realNetworkCalls: 0, oidcSignatureCheckedBy: 'separate writer admin-check and auth-check' }));
} finally {
  await mf.dispose();
  await rm(temp, { recursive: true, force: true });
}
