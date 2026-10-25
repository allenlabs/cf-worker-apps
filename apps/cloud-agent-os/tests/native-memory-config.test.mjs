import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNativeMemory, configureNativeMemory, ensureNativeMemoryNamespace } from '../scripts/native-memory-config.mjs';
const config = () => ({accountId:'a'.repeat(32),auth:{allowedIdentities:[{email:'owner@example.invalid',subject:'generated-user'}]},agentMemory:{namespace:'private-os-memory',capture:'all-conversations'}});
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const ok=()=>({success:true,result:{name:'private-os-memory'}});
test('native memory is opt in and requires single user explicit full capture',()=>{
  assert.equal(validateNativeMemory({auth:{}}),undefined);
  assert.equal(validateNativeMemory(config()).principal,'owner@example.invalid');
  assert.throws(()=>validateNativeMemory({...config(),agentMemory:{namespace:'test'}}));
  assert.throws(()=>validateNativeMemory({...config(),auth:{allowedIdentities:[{email:'a@b.test'},{email:'b@b.test'}]}}));
  assert.throws(()=>validateNativeMemory({...config(),agentMemory:{...config().agentMemory,namespace:'x'.repeat(33)}}));
  assert.throws(()=>validateNativeMemory({...config(),agentMemory:{...config().agentMemory,tags:['bot']}}));
  assert.throws(()=>validateNativeMemory({...config(),siteLaunch:{parentOrigins:['https://example.invalid']}}));
});
test('binding is internal to Workshop; no shared token is emitted',()=>{
  const generated={workshop:{vars:{EXISTING:'value'}},router:{vars:{}}};
  configureNativeMemory(generated,config());
  assert.deepEqual(generated.workshop.agent_memory,[{binding:'OS_AGENT_MEMORY',namespace:'private-os-memory'}]);
  assert.equal(generated.workshop.vars.AUTO_MEMORY_OWNER,'owner@example.invalid');
  assert.equal(generated.router.agent_memory,undefined); assert.equal(generated.workshop.vars.EXISTING,'value');
  assert.ok(!JSON.stringify(generated).includes('TOKEN'));
});
test('existing namespace is verified without POST',async()=>{
  const calls=[];
  await ensureNativeMemoryNamespace(config(),'test-token',async(url,init)=>{calls.push({url,init}); return reply(200,ok());});
  assert.equal(calls.length,1);assert.equal(calls[0].init.method,'GET');assert.ok(calls[0].url.endsWith('/private-os-memory'));
});
test('missing namespace is created and read back',async()=>{
  const calls=[];const responses=[reply(404,{success:false}),reply(200,ok()),reply(200,ok())];
  await ensureNativeMemoryNamespace(config(),'test-token',async(url,init)=>{calls.push({url,init});return responses.shift();});
  assert.deepEqual(calls.map(c=>c.init.method),['GET','POST','GET']);assert.deepEqual(JSON.parse(calls[1].init.body),{name:'private-os-memory'});
});
test('concurrent namespace creation accepts 409 only after verified read back',async()=>{
  const replies=[reply(404,{success:false}),reply(409,{success:false}),reply(200,ok())];
  await ensureNativeMemoryNamespace(config(),'test-token',async()=>replies.shift());
});
test('auth failure never tries namespace creation and does not disclose credentials',async()=>{
  let calls=0;
  await assert.rejects(()=>ensureNativeMemoryNamespace(config(),'super-secret',async()=>{calls++;return reply(403,{success:false,errors:[{message:'super-secret'}]});}),error=>!error.message.includes('super-secret'));
  assert.equal(calls,1);
});
test('invalid API response and wrong namespace fail closed',async()=>{
  await assert.rejects(()=>ensureNativeMemoryNamespace(config(),'test-token',async()=>reply(200,{success:false})));
  await assert.rejects(()=>ensureNativeMemoryNamespace(config(),'test-token',async()=>reply(200,{success:true,result:{name:'other'}})));
});
test('no native configuration makes no API request or token demand',async()=>{
  let called=false;await ensureNativeMemoryNamespace({auth:{}},undefined,async()=>{called=true;});assert.equal(called,false);
});

test('frozen provisioning checks the sealed deployment digest and account before network I/O', async () => {
  const { createHash } = await import('node:crypto');
  const { provisionFrozenNativeMemory } = await import('../scripts/native-memory-config.mjs');
  assert.equal(typeof provisionFrozenNativeMemory,'function');
  const config = { accountId:'a'.repeat(32), auth:{mode:'access',allowedEmails:['owner@example.com']}, agentMemory:{namespace:'test-memory',capture:'all-conversations'} };
  const bytes=Buffer.from(JSON.stringify(config));
  const digest=createHash('sha256').update(bytes).digest('hex');
  let calls=0;
  const fetchImpl=async()=>{calls++;return Response.json({success:true,result:{name:'test-memory'}})};
  await assert.rejects(provisionFrozenNativeMemory({bytes,expectedDigest:'f'.repeat(64),accountId:config.accountId,token:'test-only',fetchImpl}),/CONFIG_CHANGED/);
  await assert.rejects(provisionFrozenNativeMemory({bytes,expectedDigest:digest,accountId:'b'.repeat(32),token:'test-only',fetchImpl}),/ACCOUNT_INVALID/);
  assert.equal(calls,0);
  await provisionFrozenNativeMemory({bytes,expectedDigest:digest,accountId:config.accountId,token:'test-only',fetchImpl});
  assert.equal(calls,1);
});
