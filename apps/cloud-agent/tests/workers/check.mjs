import { piTextModules } from "./pi-modules.mjs";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://pi.invalid';
const sourceOrigin = 'https://events.example.invalid';
const channel = 'sample-channel', group = 'sample-group', app = 'sample-app';
const bearer = randomBytes(32).toString('base64url');
const wrapping = randomBytes(32).toString('base64url');
const faultsOnly = process.argv.includes('--faults-only');
const commandsOnly = process.argv.includes('--commands-only');
const storage = await mkdtemp(join(tmpdir(), 'pi-channel-check-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const threadKey = root => `channel-${hash(JSON.stringify([channel, group, root]))}`;
const operation = message => `ctm-${hash(JSON.stringify([channel, group, message]))}`;
await writeFile('build/pi/channel-wrapper.js', `import worker, {Assistant as BaseAssistant, Credentials as BaseCredentials} from './index.js';
export default worker;
export class Assistant extends BaseAssistant {
  constructor(ctx,env) {
    super(ctx,env);
    if (env.TEST_HOLD === 'legacy-blocked') {
      const setResponses=this.faux.setResponses;
      this.faux.setResponses=()=>setResponses([(_context,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('fixture legacy task aborted')),{once:true}))]);
      this.faux.setResponses();
    }
  }
  async queue(...args) {
    if (args[0] === 'processChannelMessage' && this.env.TEST_FAIL_QUEUE === 'true' && !this.failedQueue) { this.failedQueue=true; throw new Error('fixture queue push failed'); }
    return super.queue(...args);
  }
  async ask(prompt,operationId,pinned){
    if(this.failNextAdmission){this.failNextAdmission=false;const store=this.conversationStore,real=store.persist.bind(store);
      store.persist=async writes=>{if(writes.some(write=>write.type==='submission'&&write.value.requestId===operationId)){store.persist=real;const db=store.db;store.db={prepare:sql=>{if(sql.includes('SELECT checksum,payload'))throw Error('fixture_confirm_unavailable');return db.prepare(sql);},batch:async statements=>{await db.batch(statements);throw Error('fixture_lost_admission_response');}};try{return await real(writes);}finally{store.db=db;}}return real(writes);};
    }
    return super.ask(prompt,operationId,pinned);
  }
  async processChannelMessage(payload) {
    if (this.env.TEST_HOLD === 'accepted') await new Promise(() => {});
    return super.processChannelMessage(payload);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/test/poison-admission') {await this.harness.pi();this.failNextAdmission=true;return Response.json({armed:true});}
    if (new URL(request.url).pathname === '/test/admit') { try {return Response.json(await this.acceptChannel(await request.json()));}catch(error){return Response.json({error:error.message},{status:500});} }
    if (new URL(request.url).pathname === '/test/state') return Response.json({ ...await this.channelHistory(), queue: await this.getQueues(), pending: await this.harness.pending(), tasks: (await (await this.harness.pi()).inspect(this.piContext)).tasks.map(task=>({id:task.record.id,kind:task.record.kind,conversationId:task.record.conversationId,state:task.state.kind})), sessions: (await this.harness.sessions.list()).map(session=>session.id), nativeUsage: await (await this.harness.pi()).usage(this.piContext), modelCalls: this.faux?.state.callCount ?? 0, nativeTranscriptRows:this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pi_entries").toArray()[0].n,rawTerminalRows:this.channelSql.exec("SELECT COUNT(*) AS n FROM channel_messages WHERE state='sent' AND (data<>'{}' OR answer IS NOT NULL)").toArray()[0].n });
    if (new URL(request.url).pathname === '/test/manual-ask') {try {const body=await request.json();return Response.json(await this.manualAsk(body.prompt,body.operationId,body.accountId));}catch(error){return Response.json({error:error.message},{status:400});}}
    if (new URL(request.url).pathname === '/test/publish-usage') return Response.json(await this.publishUsage());
    if (new URL(request.url).pathname === '/test/admin-settings') return Response.json(await this.adminSettings());
    if (new URL(request.url).pathname === '/test/admin-control') {try{return Response.json(await this.adminControl(await request.json()));}catch(error){return Response.json({error:error.message},{status:error.message==='thread_busy'?409:400});}}
    if (new URL(request.url).pathname === '/test/admin-interrupted') {
      const input=await request.json();const created=await this.harness.sessions.create();this.saveRuntime({...this.runtime(),sessionId:created.id});
      this.channelSql.exec("INSERT INTO admin_controls (operationId,request,state,updatedAt) VALUES (?,?,'running',?)",input.operationId,JSON.stringify([input.action,input.args]),Date.now());
      return Response.json({created:created.id});
    }
    if (new URL(request.url).pathname === '/test/native-skill') {const snapshot=await this.operationSnapshot();return Response.json(await this.ask('Use the approved fixture skill and its guide.', 'native-skill-check', {...snapshot,skillName:'fixture-skill',skillAutomatic:true}));}
    if (new URL(request.url).pathname === '/test/long-context') {
      const conversation=await this.conversation(this.runtime().sessionId);
      for(const content of ['LONG_CONTEXT '.repeat(4000),'MORE_CONTEXT '.repeat(4000),'RECENT_CONTEXT']) await (await conversation.submit({type:'write',entry:{kind:'pi.user',model:[{role:'user',content,timestamp:Date.now()}]}},this.piContext)).wait(this.piContext);
      return Response.json({ok:true});
    }
    if (new URL(request.url).pathname === '/test/legacy-task') {
      const input=await request.json();const snapshot=await this.operationSnapshot();
      this.channelSql.exec('UPDATE channel_messages SET state=?,snapshot=? WHERE operationId=?',input.kind==='compact'?'command_running':'submitted',JSON.stringify(snapshot),input.operationId);
      this.faux.setResponses([(_context,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('fixture legacy task aborted')),{once:true}))]);
      if(input.kind==='compact')await (await this.conversation(snapshot.sessionId)).compact(undefined,this.piContext);
      else await this.harness.session(snapshot.sessionId).submit('LEGACY_SKILL_INPUT',{operationId:input.operationId});
      return Response.json({ok:true});
    }
    if (new URL(request.url).pathname === '/test/remove-job') { const body=await request.json(); await this.dequeue(body.operationId); return Response.json({ok:true}); }
    if (new URL(request.url).pathname === '/test/legacy') { this.channelSql.exec('DELETE FROM channel_runtime'); return Response.json({ok:true}); }
    if (new URL(request.url).pathname === '/test/stage') { const body=await request.json(); this.channelState(body.operationId,body.state); if(body.answer)this.channelSql.exec('UPDATE channel_messages SET answer=? WHERE operationId=?',body.answer,body.operationId); return Response.json({ok:true}); }
    return new Response('Not found',{status:404});
  }
}
export class Credentials extends BaseCredentials {
  async status() {return {...await super.status(), connected:true, directUsageGranted:true};}
  async controlSnapshot() { return await this.ctx.storage.get('fixtureControl') ?? super.controlSnapshot(); }
  async skillManifest(version) { return await this.ctx.storage.get('fixtureManifest:'+version) ?? super.skillManifest(version); }
  async channelAccess() {
    if (this.env.TEST_HOLD === 'answered') await new Promise(() => {});
    return super.channelAccess();
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/test/control'){const control=await request.json();await this.ctx.storage.put({'fixtureControl':control,['fixtureManifest:'+control.manifest.version]:control.manifest,accountSelection:{mode:'fixed',defaultAccountId:control.defaultAccountId,poolAccountIds:[]},adminAccounts:[{id:'owner',label:'Owner'},...(control.defaultAccountId==='owner'?[]:[{id:control.defaultAccountId,label:'Fixture account'}])]});return Response.json({ok:true});}
    if(path==='/test/selection'){const selection=await request.json();await this.ctx.storage.put({accountSelection:selection,accountCursor:0,adminAccounts:[...new Set(['owner',selection.defaultAccountId,...selection.poolAccountIds])].map(id=>({id,label:id}))});return Response.json({ok:true});}
    if(path==='/test/allocation')return Response.json({selection:await this.accountSelection(),cursor:await this.ctx.storage.get('accountCursor')??0,threads:await this.threads()});
    if(path==='/test/status')return Response.json(await this.status());
    if(path==='/test/access'){try{await this.channelAccess();return Response.json({ok:true});}catch(error){return Response.json({ok:false,error:error.message});}}
    if(path==='/test/expire'){const value=await this.open(await this.ctx.storage.get('channelCredential'));value.expiresAt=Date.now()+1000;await this.ctx.storage.put('channelCredential',await this.seal(value));return Response.json({ok:true});}
    if(path==='/test/clear'){await this.ctx.storage.delete('channelCredential');await this.ctx.storage.delete('channelAuthBlockedUntil');return Response.json({ok:true});}
    return Response.json({credential:await this.ctx.storage.get('channelCredential')});
  }
}`);
await writeFile('build/events/channel-wrapper.js', `import worker, {ChannelEvents as BaseEvents,ThreadHistory} from './index.js';
export default worker;
export {ThreadHistory};
export class ChannelEvents extends BaseEvents {
  async fetch(request) {
    if (new URL(request.url).pathname === '/test/direct') {const event=await request.json();try{return Response.json(await this.env.PI_ASSISTANT.get(this.env.PI_ASSISTANT.idFromName(event.threadKey)).acceptChannel(event.event));}catch(error){return Response.json({error:error.message},{status:500});}}
    if (new URL(request.url).pathname === '/test/state') return Response.json({seen:this.sql.exec('SELECT COUNT(*) AS n FROM seen').toArray()[0].n,outbox:this.sql.exec('SELECT * FROM pi_outbox ORDER BY rowid').toArray(),alarm:await this.context.storage.getAlarm()});
    if (new URL(request.url).pathname === '/test/drain') { await this.drainPi(); await this.schedule(); return Response.json({ok:true}); }
    return super.fetch(request);
  }
}`);
let issueCalls = 0, refreshCalls = 0, writeCalls = 0;
const writes = [];
const sendMode = new Map();
let tokenFault=false;
const outbound = async request => {
  assert.equal(request.url,'https://app-store-api.channel.io/general/v1/native/functions');
  assert.equal(request.method,'PUT');
  const {method,params} = await request.json();
  if (method === 'issueToken') {
    issueCalls++;
    if(tokenFault)return Response.json({error:{code:4,message:'fixture rejected token'}});
    assert.equal(params.secret,'fixture-app-secret-at-least-16');
    assert.equal(params.channelId,channel);
    await new Promise(resolve => setTimeout(resolve, 50));
    return Response.json({result:{accessToken:'fixture-channel-access',refreshToken:'fixture-channel-refresh',expiresIn:3600}});
  }
  if (method === 'refreshToken') {
    refreshCalls++;
    assert.equal(params.refreshToken,'fixture-channel-refresh');
    return Response.json({result:{accessToken:'fixture-renewed-channel-access',refreshToken:'fixture-rotated-channel-refresh',expiresIn:3600}});
  }
  assert.equal(method,'writeGroupMessage');
  assert.ok(['fixture-channel-access','fixture-renewed-channel-access'].includes(request.headers.get('x-access-token')));
  assert.equal(params.channelId,channel);
  assert.equal(params.groupId,group);
  assert.equal(params.broadcast,false);
  assert.equal(params.dto.botName,'Fixture Cloud Agent');
  assert.match(params.dto.requestId,/^ctm-[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(params.dto).sort(),['botName','plainText','requestId']);
  assert.ok(params.dto.plainText.trim());
  writeCalls++;
  writes.push(params);
  if (sendMode.get(params.rootMessageId) === 'unknown') throw new Error('fixture simulated lost response');
  if (sendMode.get(params.rootMessageId) === 'invalid') return Response.json({result:{message:{}}});
  if (sendMode.get(params.rootMessageId) === 'rejected') return Response.json({error:{code:4,type:'Forbidden',message:'fixture'}});
  return Response.json({result:{message:{id:`bot-${writeCalls}`,rootMessageId:params.rootMessageId,personType:'bot'}}});
};
const textModules = await piTextModules(resolve("build/pi"));
const options = ({hold='',enabled='true',piEnabled=enabled,failQueue='false',tenantChannel=channel}={}) => convertV4MiniflareOptions({
  resourcePersistencePath:storage,
  workers:[{
    name:'mcp-events',modulesRoot:resolve('build/events'),modules:['channel-wrapper.js','index.js'].map(name=>({type:'ESModule',path:resolve('build/events',name)})),compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{EVENTS:{className:'ChannelEvents',useSQLite:true},THREADS:{className:'ThreadHistory',useSQLite:true},PI_ASSISTANT:{className:'Assistant',scriptName:'cloud-agent',useSQLite:true}},bindings:{OWNER_LOGIN_KEY:'fixture-owner-key-at-least-32-characters',CHANNEL_APP_SIGNING_KEY:'ab'.repeat(32),ALLOWED_CHANNEL_ID:channel,ALLOWED_CHAT_ID:group,CHANNEL_SLUG:'sample-channel',CHANNEL_APP_ID:app,EVENTS_OBJECT_NAME:'sample-channel-events',PUBLIC_ORIGIN:sourceOrigin,OAUTH_OWNER_ID:'sample-owner',CHANNEL_REPLY_ENABLED:enabled},outboundService:async()=>{throw new Error('MCP test attempted outbound callback');}
  },{
    name:'cloud-agent',d1Databases:['CONVERSATIONS'],modulesRoot:resolve('build/pi'),modules:[...['channel-wrapper.js','index.js'].map(name=>({type:'ESModule',path:resolve('build/pi',name)})),...textModules],compatibilityDate:'2026-10-04',compatibilityFlags:['nodejs_compat'],durableObjects:{Assistant:{className:'Assistant',useSQLite:true},Credentials:{className:'Credentials',useSQLite:true}},bindings:{PROBE_MODE:'mock',OPENAI_MODEL:'gpt-6.1-sol',PROBE_DEADLINE_MS:'5000',PROBE_KEY_SHA256:hash(bearer),TOKEN_WRAPPING_KEY:wrapping,CHANNEL_APP_SECRET:'fixture-app-secret-at-least-16',CHANNEL_REPLY_ENABLED:piEnabled,ALLOWED_CHANNEL_ID:tenantChannel,ALLOWED_CHAT_ID:group,CHANNEL_APP_ID:app,TOKEN_WRAPPING_AAD:'fixture-cloud-agent/v1',TEST_HOLD:hold,TEST_FAIL_QUEUE:failQueue,PRODUCT_NAME:'Fixture Cloud Agent',PUBLIC_ORIGIN:origin,DIAGNOSTIC_READS_ENABLED:'true'},outboundService:outbound
  }]
});
let mf = new Miniflare(options());
const restart = async next => { await mf.dispose(); mf = new Miniflare(next); };
const events = async()=>{const ns=await mf.getDurableObjectNamespace('EVENTS','mcp-events');return ns.get(ns.idFromName('sample-channel-events'));};
const assistant = async root=>{const ns=await mf.getDurableObjectNamespace('Assistant','cloud-agent');return ns.get(ns.idFromName(threadKey(root)));};
const inspect = async root => (await (await assistant(root)).fetch('https://private.invalid/test/state')).json();
const sourceState = async()=> (await (await events()).fetch('https://private.invalid/test/state')).json();
const credentials = async(id='owner')=>{const ns=await mf.getDurableObjectNamespace('Credentials','cloud-agent');return ns.get(ns.idFromName(id));};
const accountUsage=async(id='owner')=>(await (await (await credentials(id)).fetch('https://private.invalid/test/status')).json()).usage;
const tokenFields=['input','output','cacheRead','cacheWrite','totalTokens'];
const counters=usage=>Object.fromEntries(tokenFields.map(field=>[field,usage?.[field]??0]));
const nativeTokens=usage=>Object.values(usage.models).reduce((totals,item)=>{for(const field of tokenFields)totals[field]+=item[field];return totals;},counters(null));
const api = async path => (await mf.getWorker('cloud-agent')).fetch(origin+path,{headers:{authorization:`Bearer ${bearer}`}});
const waitFor = async(predicate,label,ms=12000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}console.error(JSON.stringify({label,source:await sourceState()}));throw new Error(label);};
const waitReceipt = async(root,state='sent',ms=12000)=>{try{return await waitFor(async()=>{const info=await inspect(root);return info.receipts.find(row=>row.state===state)?info:null;},`${root} did not reach ${state}`,ms);}catch(error){console.error(JSON.stringify({root,state,inspection:await inspect(root)}));throw error;}};
const envelope = (messageId,text,extra={}) => ({systemVersion:'v1',method:'hooks.teamChatMessageCreated',context:{channel:{id:channel}},params:{eventId:`delivery-${messageId}`,channelId:channel,groupId:group,messageId,occurredAt:new Date().toISOString(),snapshot:{personType:'manager',personId:'fixture-manager',plainText:text,threadMsg:false,...extra.snapshot},...extra.params}});
const send = async input => {
  const body=JSON.stringify(input);
  return (await mf.getWorker('mcp-events')).fetch(sourceOrigin+'/functions/v1',{method:'PUT',headers:{'x-signature':createHmac('sha256',Buffer.from('ab'.repeat(32),'hex')).update(body).digest('base64')},body});
};
const accept = async input => {const response=await send(input);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).result.hookHandlingResult,'succeeded');};
try {
  await restart(options({tenantChannel:''}));
  const unconfiguredEvent={name:'channel.message.created',eventId:'missing-config',timestamp:new Date().toISOString(),data:{channel_id:channel,chat_id:group,message_id:'missing-config',root_message_id:'missing-config',is_root:true,sender_type:'manager',text:'Must not run'}};
  const denied=await (await assistant('missing-config')).fetch('https://private.invalid/test/admit',{method:'POST',body:JSON.stringify(unconfiguredEvent)});
  assert.equal(denied.status,500);assert.equal((await denied.json()).error,'channel_configuration_invalid');assert.equal(writeCalls,0);
  await restart(options());
  if(!faultsOnly&&!commandsOnly) {
  assert.equal((await (await api('/channel/status')).json()).enabled,true);
  const unauthorized=await (await mf.getWorker('cloud-agent')).fetch(origin+'/channel/history?root=A');
  assert.equal(unauthorized.status,401);
  const invalidRoot=await api('/channel/history?root=../A');assert.equal(invalidRoot.status,400);
  await Promise.all([accept(envelope('root-A','MARKER_A=blue')),accept(envelope('root-B','MARKER_B=red'))]);
  try { await waitReceipt('root-A');await waitReceipt('root-B'); } catch(error) { console.error(JSON.stringify({a:await inspect('root-A'),b:await inspect('root-B')}));const failed=(await sourceState()).outbox[0];try{await (await assistant('root-A')).acceptChannel(JSON.parse(failed.event));}catch(direct){console.error('DIRECT_ADMISSION',direct.message);console.error('LOCAL_ADMISSION',await (await (await assistant('root-A')).fetch('https://private.invalid/test/admit',{method:'POST',body:failed.event})).text());console.error('CROSS_ADMISSION',await (await (await events()).fetch('https://private.invalid/test/direct',{method:'POST',body:JSON.stringify({threadKey:failed.threadKey,event:JSON.parse(failed.event)})})).text());}throw error; }
  assert.equal(issueCalls,1,'shared credential actor issues once across roots');
  const cns=await mf.getDurableObjectNamespace('Credentials','cloud-agent');
  const encrypted=await (await cns.get(cns.idFromName('owner')).fetch('https://private.invalid/test')).json();
  assert.ok(encrypted.credential.ciphertext);assert.ok(!JSON.stringify(encrypted).includes('fixture-channel-refresh'));
  const followup=envelope('reply-A','Recall MARKER_A', {snapshot:{threadMsg:true,rootMessageId:'root-A'}});
  await accept(followup);await accept(followup);
  await accept({...followup,params:{...followup.params,eventId:'delivery-new-id-same-message'}});
  await waitFor(async()=>{const i=await inspect('root-A');return i.receipts.length===2&&i.receipts.every(r=>r.state==='sent');},'A followup did not settle');
  await Promise.all([accept(envelope('reply-A2','ORDER_A2',{snapshot:{threadMsg:true,rootMessageId:'root-A'}})),accept(envelope('reply-A3','ORDER_A3',{snapshot:{threadMsg:true,rootMessageId:'root-A'}}))]);
  await waitFor(async()=>{const i=await inspect('root-A');return i.receipts.length===4&&i.receipts.every(r=>r.state==='sent');},'concurrent A followups did not settle');
  const a=await inspect('root-A'),b=await inspect('root-B');
  assert.equal(a.receipts.length,4);assert.equal(b.receipts.length,1);
  assert.ok(JSON.stringify(a.entries).includes('MARKER_A=blue'));assert.ok(!JSON.stringify(a.entries).includes('MARKER_B=red'));
  assert.ok(JSON.stringify(b.entries).includes('MARKER_B=red'));assert.ok(!JSON.stringify(b.entries).includes('MARKER_A=blue'));
  assert.deepEqual(a.receipts.slice(0,2).map(r=>r.messageId),['root-A','reply-A']);
  const commentOrder=a.receipts.slice(2).map(row=>row.messageId);assert.deepEqual(new Set(commentOrder),new Set(['reply-A2','reply-A3']));
  const transcript=JSON.stringify(a.entries);assert.ok(transcript.indexOf(commentOrder[0]==='reply-A2'?'ORDER_A2':'ORDER_A3')<transcript.indexOf(commentOrder[1]==='reply-A2'?'ORDER_A2':'ORDER_A3'));
  assert.deepEqual(writes.filter(row=>row.rootMessageId==='root-A').slice(2).map(row=>row.dto.requestId),commentOrder.map(operation));
  assert.equal(writes.filter(w=>w.rootMessageId==='root-A').length,4);assert.equal(writes.filter(w=>w.rootMessageId==='root-B').length,1);
  assert.equal(writes.filter(w=>w.dto.requestId===operation('reply-A')).length,1);
  assert.equal(a.queue.length,0);assert.deepEqual(a.pending,[]);
  assert.equal(a.nativeTranscriptRows,0);assert.equal(a.rawTerminalRows,0);
  const recoveryRoot='ambiguous-admission-root';
  assert.equal((await (await assistant(recoveryRoot)).fetch('https://private.invalid/test/poison-admission')).status,200);
  await accept(envelope(recoveryRoot,'AMBIGUOUS_ADMISSION_CONTEXT'));
  const recoveredAdmission=await waitReceipt(recoveryRoot);
  assert.equal(recoveredAdmission.modelCalls,1);assert.equal(recoveredAdmission.nativeTranscriptRows,0);assert.equal(recoveredAdmission.rawTerminalRows,0);
  assert.equal(recoveredAdmission.receipts[0].snapshot.accountId,'owner');assert.equal(recoveredAdmission.receipts[0].snapshot.sessionId,'1');
  assert.equal(recoveredAdmission.receipts[0].text,'AMBIGUOUS_ADMISSION_CONTEXT');assert.equal(writes.filter(row=>row.rootMessageId===recoveryRoot).length,1);
  assert.equal(recoveredAdmission.entries.filter(entry=>entry.kind==='pi.user').length,1);assert.deepEqual(recoveredAdmission.pending,[]);

  const beforeFilters=writeCalls;
  const skipped=[envelope('wrong-group','ignored',{params:{groupId:'other'}}),envelope('wrong-channel','ignored',{params:{channelId:'999'}}),envelope('customer','ignored',{snapshot:{personType:'user'}}),envelope('self-source','ignored',{params:{sourceAppId:app}})];
  for(const input of skipped){const response=await send(input);assert.equal(response.status,200);assert.notEqual((await response.json()).result.hookHandlingResult,'succeeded');}
  for(const input of [envelope('other-bot','ignored',{snapshot:{personType:'bot'}}),envelope('ambiguous','ignored',{snapshot:{threadMsg:undefined}}),envelope('contradiction','ignored',{snapshot:{rootMessageId:'root-A',threadId:'root-B',threadMsg:true}}),envelope('false-root','ignored',{snapshot:{rootMessageId:'root-A',threadMsg:false}}),envelope('empty','')]) await accept(input);
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(writeCalls,beforeFilters);
  assert.equal((await sourceState()).outbox.length,0);
  const ownBot=envelope(a.receipts[0].replyId,'MOCK_OK',{snapshot:{personType:'bot',threadMsg:true,rootMessageId:'root-A'}});await accept(ownBot);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(writeCalls,beforeFilters);
  await restart(options());await accept(followup);assert.equal((await inspect('root-A')).receipts.length,4);assert.equal(writeCalls,beforeFilters);
  // A failed queue head controls the alarm, even if a later row is already due.
  await restart(options({piEnabled:'false'}));
  await accept(envelope('outbox-root','OUTBOX_MARKER'));await accept(envelope('outbox-tail','OUTBOX_TAIL'));
  await (await events()).fetch('https://private.invalid/test/drain');
  let blocked=await sourceState();assert.equal(blocked.outbox.length,2);assert.ok(blocked.outbox[0].nextAttempt>Date.now());assert.ok(blocked.alarm>=blocked.outbox[0].nextAttempt);
  await accept(envelope('outbox-root','OUTBOX_MARKER'));assert.equal((await sourceState()).outbox.filter(row=>JSON.parse(row.event).data.message_id==='outbox-root').length,1);
  await restart(options());await waitReceipt('outbox-root');await waitReceipt('outbox-tail');assert.equal((await sourceState()).outbox.length,0);
  await restart(options({hold:'accepted'}));await accept(envelope('recovery-accepted','RECOVER_ACCEPTED'));
  await waitFor(async()=>{const i=await inspect('recovery-accepted');return i.receipts[0]?.state==='accepted';},'accepted stage not persisted');
  await restart(options());await waitReceipt('recovery-accepted','sent',40000);assert.equal(writes.filter(w=>w.rootMessageId==='recovery-accepted').length,1);
  await restart(options({hold:'answered'}));await accept(envelope('recovery-answer','RECOVER_ANSWER'));await waitReceipt('recovery-answer','answered');
  await restart(options());const recovered=await waitReceipt('recovery-answer','sent',40000);assert.equal(writes.filter(w=>w.rootMessageId==='recovery-answer').length,1);assert.equal(recovered.receipts.length,1);assert.equal(recovered.entries.length,2);
  for(const [root,mode,state] of [['unknown-root','unknown','delivery_unknown'],['invalid-receipt','invalid','delivery_unknown'],['rejected-root','rejected','delivery_failed']]) {
    sendMode.set(root,mode);const message=envelope(root,'FAILURE_MARKER');await accept(message);await waitReceipt(root,state);
    await accept({...message,params:{...message.params,eventId:`repeat-${root}`}});await restart(options());await new Promise(resolve=>setTimeout(resolve,100));assert.equal(writes.filter(w=>w.rootMessageId===root).length,1);
  }
  await restart(options({hold:'answered'}));await accept(envelope('interrupted-send','INTERRUPTED_MARKER'));await waitReceipt('interrupted-send','answered');
  await (await assistant('interrupted-send')).fetch('https://private.invalid/test/stage',{method:'POST',body:JSON.stringify({operationId:operation('interrupted-send'),state:'sending'})});
  await restart(options());await waitReceipt('interrupted-send','delivery_unknown',40000);assert.equal(writes.filter(w=>w.rootMessageId==='interrupted-send').length,0);
  await restart(options({enabled:'false'}));const beforeOff=writeCalls;await accept(envelope('disabled-root','DISABLED_MARKER'));
  assert.equal((await sourceState()).outbox.length,0);await restart(options());await new Promise(resolve=>setTimeout(resolve,100));assert.equal(writeCalls,beforeOff);
  const status=await (await api('/channel/status')).json();assert.equal(status.cachedToken,true);
  const history=await (await api('/channel/history?root=root-A')).json();assert.equal(history.threadKey,threadKey('root-A'));assert.equal(history.receipts.length,4);
  for(const secret of [bearer,wrapping,'fixture-app-secret-at-least-16','fixture-channel-access','fixture-channel-refresh']) assert.ok(!JSON.stringify({status,history}).includes(secret));
  }
  if(!commandsOnly) {
  // A rejected queue promise must leave the forward outbox pending and duplicate admission repairs the missing native job.
  await restart(options({failQueue:'true'}));
  await accept(envelope('queue-fault-root','QUEUE_FAULT_MARKER'));
  await waitFor(async()=>{const state=await sourceState();return state.outbox[0]?.attempts>=1;},'failed queue push did not retain durable forward work');
  assert.equal((await sourceState()).outbox.length,1);
  await restart(options());const repaired=await waitReceipt('queue-fault-root');
  assert.equal(repaired.receipts.length,1);assert.equal(repaired.entries.length,2);assert.equal(writes.filter(row=>row.rootMessageId==='queue-fault-root').length,1);
  await restart(options({hold:'accepted'}));
  const missingMessage=envelope('missing-job-root','MISSING_JOB_MARKER');await accept(missingMessage);
  await waitFor(async()=>{const info=await inspect('missing-job-root');return info.receipts[0]?.state==='accepted'&&info.queue.length===1;},'missing job fixture was not admitted');
  await (await assistant('missing-job-root')).fetch('https://private.invalid/test/remove-job',{method:'POST',body:JSON.stringify({operationId:operation('missing-job-root')})});
  await restart(options());await accept({...missingMessage,params:{...missingMessage.params,eventId:'missing-job-new-delivery'}});
  const missingRepaired=await waitReceipt('missing-job-root');assert.equal(missingRepaired.receipts.length,1);assert.equal(missingRepaired.entries.length,2);assert.equal(writes.filter(row=>row.rootMessageId==='missing-job-root').length,1);
  const cred=async()=>{const ns=await mf.getDurableObjectNamespace('Credentials','cloud-agent');return ns.get(ns.idFromName('owner'));};
  await (await cred()).fetch('https://private.invalid/test/expire');
  const refreshBefore=refreshCalls;
  const cached=await Promise.all(Array.from({length:3},async()=> (await (await cred()).fetch('https://private.invalid/test/access')).json()));
  assert.ok(cached.every(result=>result.ok));assert.equal(refreshCalls,refreshBefore+1);
  await (await cred()).fetch('https://private.invalid/test/clear');tokenFault=true;
  const issueBefore=issueCalls;
  const rejected=await Promise.all(Array.from({length:3},async()=> (await (await cred()).fetch('https://private.invalid/test/access')).json()));
  assert.ok(rejected.every(result=>!result.ok));assert.equal(issueCalls,issueBefore+1);
  const blockedAgain=await (await (await cred()).fetch('https://private.invalid/test/access')).json();assert.equal(blockedAgain.error,'channel_auth_cooldown');assert.equal(issueCalls,issueBefore+1);
  const blockedStatus=await (await api('/channel/status')).json();assert.ok(blockedStatus.tokenIssueCooldownUntil>Date.now());
  }
  if(!faultsOnly) {
    tokenFault=false;
    await restart(options());
    const resetCredentials=await mf.getDurableObjectNamespace('Credentials','cloud-agent');
    await resetCredentials.get(resetCredentials.idFromName('owner')).fetch('https://private.invalid/test/clear');
    const root='commands-root';
    await accept(envelope(root,'OLD_CONTEXT_MARKER'));await waitReceipt(root);
    const command = async(id,text) => {
      await accept(envelope(id,text,{snapshot:{threadMsg:true,rootMessageId:root}}));
      return waitFor(async()=>{const info=await inspect(root);return info.receipts.find(row=>row.messageId===id)?.state==='sent'?info:null;},id+' command did not settle');
    };
    const control = async(action,args='',operationId='admin-'+crypto.randomUUID()) => {
      const response=await (await assistant(root)).fetch('https://private.invalid/test/admin-control',{method:'POST',body:JSON.stringify({operationId,action,args})});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    let info=await inspect(root);const originalSession=info.selected.sessionId;
    const calls=info.modelCalls,entries=info.entries.length;
    const controlsUsage=counters(await accountUsage()),controlsNative=nativeTokens(info.nativeUsage);assert.ok(controlsNative.totalTokens>0);
    for(const [id,text] of [['help','/ai'],['help-ko','/ai 도움말'],['help-en','/ai help'],['model','/ai model'],['model-ko','/ai 모델'],['thinking','/ai thinking'],['thinking-ko','/ai 생각'],['thinking-en-change','/ai thinking high'],['thinking-ko-change','/ai 생각 보통'],['model-ko-change','/ai 모델 기본'],['model-number','/ai 모델 1'],['model-en-change','/ai model faux/probe'],['thinking-invalid','/ai 생각 invalid']]) info=await command(id,text);
    for(const name of ['new','resume','name','clone','fork','tree','session','settings','copy','export','skills','reload','compact','login','logout','changelog','abort','unsupported','skill:fixture-skill','skill:INVALID']) {
      info=await command('denied-'+name.replace(':','-'),'/ai '+name);
      assert.ok(info.receipts.at(-1).answer.includes(origin));assert.ok(!info.receipts.at(-1).answer.includes('owner'));
    }
    assert.equal(info.modelCalls,calls);assert.equal(info.entries.length,entries);assert.equal(info.selected.sessionId,originalSession);assert.deepEqual(counters(await accountUsage()),controlsUsage);assert.deepEqual(nativeTokens(info.nativeUsage),controlsNative);
    for(const row of info.receipts.filter(row=>['model','model-ko','thinking','thinking-ko'].includes(row.messageId))) for(const internal of ['세션:', '구독 계정:', '스킬:', 'owner', 'empty']) assert.ok(!row.answer.includes(internal));
    let settings=await (await (await assistant(root)).fetch('https://private.invalid/test/admin-settings')).json();
    assert.equal(settings.thinking.value,'medium');assert.equal(settings.models.length,1);assert.equal(settings.userEntries[0].preview,'OLD_CONTEXT_MARKER');
    const adminWrites=writeCalls;
    await control('name','원래 세션');
    const newId='admin-'+crypto.randomUUID();let changed=await control('new','',newId);const newSession=changed.settings.selected.sessionId;
    assert.notEqual(newSession,originalSession);assert.equal((await inspect(root)).entries.length,0);
    await control('new','',newId);assert.equal((await inspect(root)).sessions.length,2);
    const conflict=await (await assistant(root)).fetch('https://private.invalid/test/admin-control',{method:'POST',body:JSON.stringify({operationId:newId,action:'clone',args:''})});
    assert.equal(conflict.status,400);assert.equal((await conflict.json()).error,'admin_operation_conflict');
    info=await command('new-context','NEW_CONTEXT_MARKER');assert.ok(!JSON.stringify(info.entries).includes('OLD_CONTEXT_MARKER'));
    await control('resume',originalSession);info=await inspect(root);assert.ok(JSON.stringify(info.entries).includes('OLD_CONTEXT_MARKER'));assert.ok(!JSON.stringify(info.entries).includes('NEW_CONTEXT_MARKER'));
    const userEntry=info.entries.find(row=>row.kind==='pi.user').id;
    const beforeForkNative=nativeTokens(info.nativeUsage),beforeForkUsage=counters(await accountUsage());
    await control('clone');assert.ok(JSON.stringify((await inspect(root)).entries).includes('OLD_CONTEXT_MARKER'));
    await control('fork',String(userEntry));assert.equal((await inspect(root)).entries.length,1);
    assert.deepEqual(nativeTokens((await inspect(root)).nativeUsage),beforeForkNative);await (await assistant(root)).fetch('https://private.invalid/test/publish-usage');assert.deepEqual(counters(await accountUsage()),beforeForkUsage);
    await control('resume',originalSession);await control('model','1');await control('thinking','high');await control('reload');
    assert.equal(writeCalls,adminWrites+1);
    assert.equal((await inspect(root)).selected.accountId,'owner');
    await (await assistant(root)).fetch('https://private.invalid/test/legacy');await restart(options());
    info=await inspect(root);assert.equal(info.selected.accountId,'owner');assert.equal(info.selected.sessionId,'1');
    const cns=await mf.getDurableObjectNamespace('Credentials','cloud-agent');const owner=cns.get(cns.idFromName('owner'));
    const skill={name:'fixture-skill',description:'Respond according to fixture instructions',body:'SKILL_REVISION_ONE. Return the requested result.',rawContent:'---\nname: fixture-skill\ndescription: Respond according to fixture instructions\n---\nSKILL_REVISION_ONE.',version:'one',resources:[{path:'references/guide.md',kind:'reference',encoding:'text',content:'REFERENCE_REVISION_ONE'}]};
    const config={defaultAccountId:'account-11111111-1111-4111-8111-111111111111',manifest:{version:'revision-one',skills:[skill]}};
    await owner.fetch('https://private.invalid/test/control',{method:'POST',body:JSON.stringify(config)});
    info=await command('pinned-manifest','PINNED_MANIFEST_MARKER');assert.equal(info.receipts.at(-1).snapshot.manifestVersion,'revision-one');
    const nativeSkill=await (await (await assistant(root)).fetch('https://private.invalid/test/native-skill')).json();assert.equal(nativeSkill.status,'done');
    for(const marker of ['activate_skill','SKILL_REVISION_ONE','read_skill_resource','REFERENCE_REVISION_ONE']) assert.ok(JSON.stringify(nativeSkill.entries).includes(marker));
    const fresh='new-account-root';await accept(envelope(fresh,'PINNED_ACCOUNT_MARKER'));await waitReceipt(fresh);assert.equal((await inspect(fresh)).selected.accountId,config.defaultAccountId);
    await owner.fetch('https://private.invalid/test/control',{method:'POST',body:JSON.stringify({...config,defaultAccountId:'owner',manifest:{version:'revision-two',skills:[{...skill,version:'two',body:'SKILL_REVISION_TWO'}]}})});
    await restart(options());assert.equal((await inspect(fresh)).selected.accountId,config.defaultAccountId);assert.equal((await inspect(root)).receipts.find(row=>row.messageId==='pinned-manifest').snapshot.manifestVersion,'revision-one');
    const interruptedId='admin-'+crypto.randomUUID();
    await (await assistant(root)).fetch('https://private.invalid/test/admin-interrupted',{method:'POST',body:JSON.stringify({operationId:interruptedId,action:'new',args:''})});
    const interruptedState=await inspect(root);await restart(options());const uncertain=await control('new','',interruptedId);
    assert.equal(uncertain.status,'uncertain');assert.equal(uncertain.settings.selected.sessionId,interruptedState.selected.sessionId);assert.equal((await inspect(root)).sessions.length,interruptedState.sessions.length);
    await restart(options({hold:'accepted'}));const busyRoot='busy-admin-root';await accept(envelope(busyRoot,'BUSY_CONTEXT'));
    await waitFor(async()=>{const state=await inspect(busyRoot);return state.queue.length===1?state:null;},'busy fixture not queued');
    const busy=await (await assistant(busyRoot)).fetch('https://private.invalid/test/admin-control',{method:'POST',body:JSON.stringify({operationId:'admin-'+crypto.randomUUID(),action:'new',args:''})});assert.equal(busy.status,409);assert.equal((await busy.json()).error,'thread_busy');
    await (await assistant(busyRoot)).fetch('https://private.invalid/test/remove-job',{method:'POST',body:JSON.stringify({operationId:operation(busyRoot)})});
    assert.equal((await inspect(busyRoot)).queue.length,0);
    const ledgerBusy=await (await assistant(busyRoot)).fetch('https://private.invalid/test/admin-control',{method:'POST',body:JSON.stringify({operationId:'admin-'+crypto.randomUUID(),action:'new',args:''})});assert.equal(ledgerBusy.status,409);assert.equal((await ledgerBusy.json()).error,'thread_busy');
    await restart(options());await accept(envelope(busyRoot,'BUSY_CONTEXT',{params:{eventId:'busy-repair-delivery'}}));await waitReceipt(busyRoot,'sent',40000);
    for(const state of ['accepted','submitted','answered','command_running']) {
      await restart(options({hold:'accepted'}));const oldRoot='old-command-'+state;await accept(envelope(oldRoot,'/ai new'));await waitReceipt(oldRoot,'accepted');
      await (await assistant(oldRoot)).fetch('https://private.invalid/test/stage',{method:'POST',body:JSON.stringify({operationId:operation(oldRoot),state,answer:'OLD_ADVANCED_ANSWER owner session 1'})});
      await (await assistant(oldRoot)).fetch('https://private.invalid/test/remove-job',{method:'POST',body:JSON.stringify({operationId:operation(oldRoot)})});
      await restart(options());await accept(envelope(oldRoot,'/ai new',{params:{eventId:'retry-'+oldRoot}}));const settled=await waitReceipt(oldRoot);assert.equal(settled.modelCalls,0);assert.equal(settled.selected.sessionId,'1');assert.equal(settled.sessions.length,1);assert.ok(settled.receipts[0].answer.includes(origin));assert.ok(!settled.receipts[0].answer.includes('OLD_ADVANCED_ANSWER'));
    }
    for(const kind of ['compact','skill']) {
      const oldRoot='old-live-'+kind;await accept(envelope(oldRoot,'INITIAL_CONTEXT'));await waitReceipt(oldRoot);
      if(kind==='compact')assert.equal((await (await assistant(oldRoot)).fetch('https://private.invalid/test/long-context')).status,200);
      await restart(options({hold:'accepted'}));const messageId='old-live-'+kind+'-control';await accept(envelope(messageId,kind==='compact'?'/ai compact':'/ai skill:fixture-skill',{snapshot:{threadMsg:true,rootMessageId:oldRoot}}));
      await waitFor(async()=>{const state=await inspect(oldRoot);return state.receipts.at(-1)?.state==='accepted'?state:null;},'old live control not accepted');
      assert.equal((await (await assistant(oldRoot)).fetch('https://private.invalid/test/legacy-task',{method:'POST',body:JSON.stringify({operationId:operation(messageId),kind})})).status,200);
      const live=await waitFor(async()=>{const state=await inspect(oldRoot);return state.tasks.some(task=>task.kind===(kind==='compact'?'pi.compaction':'pi.generation') && task.state==='running')?state:null;},'legacy native task not live');
      assert.equal(live.receipts.at(-1).snapshot.compactTaskId,undefined);
      await (await assistant(oldRoot)).fetch('https://private.invalid/test/remove-job',{method:'POST',body:JSON.stringify({operationId:operation(messageId)})});
      await restart(options({hold:'legacy-blocked'}));await accept(envelope(messageId,kind==='compact'?'/ai compact':'/ai skill:fixture-skill',{snapshot:{threadMsg:true,rootMessageId:oldRoot},params:{eventId:'retry-'+messageId}}));const settled=await waitFor(async()=>{const state=await inspect(oldRoot);return state.receipts.at(-1)?.state==='sent'?state:null;},'old live control did not settle');
      assert.equal(settled.modelCalls,0);assert.deepEqual(settled.tasks,[]);assert.deepEqual(settled.pending,[]);assert.ok(settled.receipts.at(-1).answer.includes(origin));
      await restart(options());assert.deepEqual((await inspect(oldRoot)).tasks,[]);assert.equal(writes.filter(write=>write.dto.requestId===operation(messageId)).length,1);
    }
    const selectedAccount=config.defaultAccountId;
    const allocationOwner=await credentials();
    await allocationOwner.fetch('https://private.invalid/test/selection',{method:'POST',body:JSON.stringify({mode:'round_robin',defaultAccountId:'owner',poolAccountIds:['owner',selectedAccount]})});
    await Promise.all([accept(envelope('rr-root-one','ROUND_ROBIN_ONE')),accept(envelope('rr-root-two','ROUND_ROBIN_TWO'))]);
    const rrOne=await waitReceipt('rr-root-one'),rrTwo=await waitReceipt('rr-root-two');
    assert.deepEqual(new Set([rrOne.selected.accountId,rrTwo.selected.accountId]),new Set(['owner',selectedAccount]));
    const allocationBefore=await (await allocationOwner.fetch('https://private.invalid/test/allocation')).json();assert.equal(allocationBefore.cursor,0);
    const preservedUsage=counters(await accountUsage(rrOne.selected.accountId));
    await accept(envelope('rr-root-one','ROUND_ROBIN_ONE',{params:{eventId:'rr-one-retry'}}));
    await (await assistant('rr-root-one')).fetch('https://private.invalid/test/publish-usage');
    const duplicateAllocation=await (await allocationOwner.fetch('https://private.invalid/test/allocation')).json();assert.equal(duplicateAllocation.cursor,allocationBefore.cursor);assert.deepEqual(counters(await accountUsage(rrOne.selected.accountId)),preservedUsage);
    await restart(options());
    assert.equal((await inspect('rr-root-one')).selected.accountId,rrOne.selected.accountId);assert.equal((await inspect('rr-root-two')).selected.accountId,rrTwo.selected.accountId);
    await accept(envelope('rr-followup','ROUND_ROBIN_FOLLOWUP',{snapshot:{threadMsg:true,rootMessageId:'rr-root-one'}}));
    await waitFor(async()=>{const state=await inspect('rr-root-one');return state.receipts.length===2&&state.receipts.every(row=>row.state==='sent')?state:null;},'RR pinned followup did not settle');
    const allocationAfter=await (await (await credentials()).fetch('https://private.invalid/test/allocation')).json();assert.equal(allocationAfter.cursor,0);assert.equal((await inspect('rr-root-one')).selected.accountId,rrOne.selected.accountId);
    const assistantNamespace=await mf.getDurableObjectNamespace('Assistant','cloud-agent');const manual=assistantNamespace.get(assistantNamespace.idFromName('manual-'+selectedAccount));
    const manualInput={prompt:'MANUAL_SELECTED_ACCOUNT',operationId:'manual-account-check',accountId:selectedAccount};
    const ownerBefore=counters(await accountUsage()),selectedBefore=counters(await accountUsage(selectedAccount));
    const manualResponse=await manual.fetch('https://private.invalid/test/manual-ask',{method:'POST',body:JSON.stringify(manualInput)});assert.equal(manualResponse.status,200);assert.equal((await manualResponse.json()).status,'done');
    const manualState=await (await manual.fetch('https://private.invalid/test/state')).json();const manualTokens=nativeTokens(manualState.nativeUsage);
    const selectedAfter=counters(await accountUsage(selectedAccount));for(const field of tokenFields)assert.equal(selectedAfter[field]-selectedBefore[field],manualTokens[field]);assert.ok(manualTokens.totalTokens>0);assert.deepEqual(counters(await accountUsage()),ownerBefore);
    const manualReplay=await manual.fetch('https://private.invalid/test/manual-ask',{method:'POST',body:JSON.stringify(manualInput)});assert.equal(manualReplay.status,200);assert.equal((await manualReplay.json()).status,'done');assert.deepEqual(counters(await accountUsage(selectedAccount)),selectedAfter);assert.equal((await (await manual.fetch('https://private.invalid/test/state')).json()).modelCalls,manualState.modelCalls);
    const manualSwitch=await manual.fetch('https://private.invalid/test/manual-ask',{method:'POST',body:JSON.stringify({...manualInput,accountId:'owner',operationId:'manual-forbidden-switch'})});assert.equal(manualSwitch.status,400);assert.equal((await manualSwitch.json()).error,'thread_account_mismatch');
    const usageCredential=await credentials(selectedAccount),snapshotId=hash('explicit-usage-check'),snapshot={input:10,output:8,cacheRead:3,cacheWrite:2,totalTokens:23,reasoning:5};
    const aggregateBefore=await accountUsage(selectedAccount);assert.equal((await usageCredential.reportUsage({sourceId:snapshotId,usage:snapshot})).accepted,true);
    const aggregateAfter=await accountUsage(selectedAccount);assert.equal(aggregateAfter.totalTokens-aggregateBefore.totalTokens,23);assert.equal(aggregateAfter.output-aggregateBefore.output,8);assert.equal((aggregateAfter.reasoning??0)-(aggregateBefore.reasoning??0),5);
    await usageCredential.reportUsage({sourceId:snapshotId,usage:snapshot});assert.deepEqual(counters(await accountUsage(selectedAccount)),counters(aggregateAfter));
    const olderReport=await usageCredential.reportUsage({sourceId:snapshotId,usage:{...snapshot,input:9}});assert.equal(olderReport.accepted,false);assert.equal(olderReport.reason,'older_snapshot');assert.deepEqual(counters(await accountUsage(selectedAccount)),counters(aggregateAfter));
    for(const key of ['requests','modelResponses','cost','remaining','limit'])assert.equal(aggregateAfter[key],undefined);assert.equal(aggregateAfter.quota,null);assert.equal(aggregateAfter.source,'pi_committed_usage');assert.ok(aggregateAfter.collectionStartedAt);assert.ok(aggregateAfter.lastUpdated);
  }
  console.log(JSON.stringify({checks:'PASS',runtime:'workerd',missingChannelConfigDenied:true,coreChecksExecuted:!faultsOnly&&!commandsOnly,commandChecksExecuted:!faultsOnly,...(!faultsOnly?{restrictedStaffCommands:true,koreanAliases:true,advancedSlashNoInference:true,nativeSkillsActivation:true,adminControlsIdempotent:true,adminBusyRejected:true,legacyForbiddenTaskAbortedBeforeResume:true,rootLocalSessionSwitch:true,accountPinsSurviveDefaultChange:true,atomicNewRootRoundRobin:true,roundRobinReplayAndRestart:true,nativeTokenUsage:true,usageSnapshotDeduplication:true,forkDoesNotDuplicateUsage:true,selectedAccountManualTest:true}:{}),...(!commandsOnly?{missingNativeJobRepaired:true,channelRefreshSingleflight:true,tokenFailureCooldown:true}:{}),...(!faultsOnly&&!commandsOnly?{signedNativeIngress:true,perSourceThreadIsolation:true,messageDeduplication:true,orderedFollowups:true,atomicForwardOutbox:true,headBackoffNoAlarmSpin:true,acceptAndAnswerRecovery:true,ambiguousD1AdmissionRecovery:true,nativeTranscriptRows:0,terminalTranscriptsArchived:true,unknownSendNoRetry:true,staffAndSelfLoopFilters:true,encryptedChannelCredentials:true,singleChannelTokenIssue:true,disableNoBackfill:true,protectedReadOnlyInspection:true}:{}),issueCalls,refreshCalls,writeCalls,realOpenAINetworkCalls:0,realChannelNetworkCalls:0}));
} finally { await mf.dispose();await rm(storage,{recursive:true,force:true}); }
