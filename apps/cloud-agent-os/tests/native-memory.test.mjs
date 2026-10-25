import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { NativeMemoryQueue, memoryProfileName, memorySessionId, readNativeMemoryConfig } from '../overlay/packages/workshop-backend/src/native-memory.ts';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(options = {}) {
  let time = 1_000_000;
  const saved = new Map();
  const records = new Map();
  const artifacts = new Map();
  const calls = [], profiles = [];
  let fail = false, gate, denied = false;
  const store = {
    get: id => structuredClone(saved.get(id)),
    put: value => saved.set(value.chatId, structuredClone(value)),
    delete: id => saved.delete(id),
    list: () => [...saved.values()].map(value => structuredClone(value)),
    transaction(fn) { const old = structuredClone(saved); try { return fn(); } catch (error) { saved.clear(); for (const [k,v] of old) saved.set(k,v); throw error; } },
  };
  const binding = {
    async getProfile(name) {
      profiles.push(name);
      return {
        async ingest(messages, opts) { calls.push(structuredClone({ messages, opts, name })); if (gate) await gate(); if (fail) throw new Error('secret must never appear in status'); },
        async recall(query) { return { count: 1, answer: query, candidates: [] }; },
      };
    },
  };
  const source = {
    async load(chatId, sequence) { return structuredClone(records.get(`${chatId}:${sequence}`) ?? null); },
    async authorize() { if (denied) throw new Error('revoked'); },
    async page(chatId, ref, cursor) {
      if (denied) throw new Error('revoked');
      const text = artifacts.get(ref.id);
      if (text === undefined) throw new Error('Missing artifact');
      const start = cursor ? JSON.parse(cursor).offset : 0;
      let end = start, size = 0;
      for (const cp of text.slice(start)) { const n = Buffer.byteLength(JSON.stringify(cp)); if (size + n > 2048) break; size += n; end += cp.length; }
      const eof = end === text.length;
      return { artifactId: ref.id, sha256: ref.id, start, end, totalChars: text.length, totalBytes: Buffer.byteLength(text),
        content: text.slice(start,end), nextCursor: eof ? null : JSON.stringify({offset:end}), eof };
    },
  };
  const deps = { store, source, binding, namespace:'test-memory', principal:'owner@example.invalid', workspaceId:'synthetic-workspace', now:()=>time, ...options };
  let queue = new NativeMemoryQueue(deps);
  return {
    get queue() { return queue; }, store, source, saved, calls, profiles, artifacts, deps,
    tick: (ms=60_000) => { time += ms; }, now:()=>time,
    fail: value => { fail=value; }, deny: value=>{denied=value;}, gate: value=>{gate=value;},
    restart: () => { queue = new NativeMemoryQueue(deps); },
    add(chatId, sequence, text, extra = []) {
      const refs = [text, ...extra].map((body,index) => { const id=hash(body); artifacts.set(id,body); return {id, label:index ? 'tool-result' : 'chat-record'}; });
      records.set(`${chatId}:${sequence}`, {sequence, role:'user', timestamp:'2026-10-25T00:00:00.000Z', sources:refs});
      queue.append(chatId,sequence);
      return refs;
    },
  };
}
async function drainAll(f) { for (let n=0;n<300;n++) { f.tick(4_000_000); await f.queue.drain(); if (f.queue.nextAlarm()===null) return; } throw new Error('Queue did not drain'); }

// Identity is stable independently of names/revisions and stays inside documented bounds.
test('profiles isolate principals and bot ids; sessions isolate workspace/chat', async()=>{
  const a=await memoryProfileName('owner','bot-a');
  assert.equal(a,await memoryProfileName('owner','bot-a'));
  assert.notEqual(a,await memoryProfileName('owner','bot-b'));
  assert.notEqual(a,await memoryProfileName('other','bot-a'));
  assert.notEqual(await memoryProfileName('a:b','c'),await memoryProfileName('a','b:c'));
  assert.ok(a.length<=100);
  assert.ok((await memorySessionId('ws',12)).length<=64);
  assert.notEqual(await memorySessionId('ws',12),await memorySessionId('ws2',12));
});
test('native configuration is explicit and missing binding does not disable capture',()=>{
  assert.equal(readNativeMemoryConfig({}),undefined);
  assert.deepEqual(readNativeMemoryConfig({AUTO_MEMORY_OWNER:'owner@example.invalid',AUTO_MEMORY_NAMESPACE:'test-memory'}),{principal:'owner@example.invalid',namespace:'test-memory'});
  assert.throws(()=>readNativeMemoryConfig({AUTO_MEMORY_OWNER:'x'}));
});
test('idle ingestion automatically gets profile, preserves complete Unicode and tool originals',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot-a');
  const original='\ufeff한국어 👨‍👩‍👧‍👦 e\u0301 '+JSON.stringify({ value:'"\\\n\t'.repeat(9000), ending:'DO NOT DROP THIS 끝' });
  const tool='tool result\n'+ '🙂'.repeat(30000) +'\nLAST';
  const refs=f.add(1,0,original,[tool]);
  await f.queue.drain(); assert.equal(f.calls.length,0);
  await drainAll(f);
  for(const [index, expected] of [original,tool].entries()) {
    const chunks=f.calls.flatMap(c=>c.messages.map(m=>JSON.parse(m.content))).filter(p=>p.artifactId===refs[index].id);
    assert.equal(chunks.map(c=>c.content).join(''), expected);
    assert.ok(chunks.at(-1).eof);
  }
  assert.ok(f.calls.every(c=>c.messages.length<=500 && c.messages.every(m=>Buffer.byteLength(m.content)<=32768)));
  assert.equal(f.queue.status(1).acknowledgedThrough,0);
  assert.equal(f.queue.status(1).state,'caught-up');
  assert.equal(new Set(f.profiles).size,1);
});
test('failed ingest keeps byte-identical batch across restart and never advances cursor',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'test'.repeat(4000)); f.fail(true); f.tick(); await f.queue.drain();
  assert.equal(f.queue.status(1).acknowledgedThrough,-1);
  assert.equal(f.queue.status(1).state,'retrying');
  assert.ok(!JSON.stringify(f.queue.status(1)).includes('secret'));
  const first=structuredClone(f.calls[0]); f.restart(); f.fail(false); f.tick(4_000_000); await f.queue.drain();
  assert.deepEqual(f.calls[1],first);
  await drainAll(f); assert.equal(f.queue.status(1).state,'caught-up');
});
test('append during remote ingest is retained by ACK transaction',async()=>{
  const f=fixture(); f.queue.enroll(1,null); f.add(1,0,'first'); f.tick();
  let resolve, started; const ready=new Promise(r=>{started=r;});
  f.gate(()=>{started(); return new Promise(r=>{resolve=r;});});
  const draining=f.queue.drain(1); await ready; f.add(1,1,'second'); resolve(); await draining; f.gate(null);
  assert.equal(f.queue.status(1).highWater,2); await drainAll(f);
  assert.equal(f.queue.status(1).acknowledgedThrough,1);
  assert.ok(f.calls.some(c=>c.messages.some(m=>JSON.parse(m.content).content==='second')));
});
test('deleting a chat while ingest is in flight cannot resurrect the queue',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'first'); f.tick();
  let resolve, started; const ready=new Promise(r=>{started=r;});
  f.gate(()=>{started(); return new Promise(r=>{resolve=r;});});
  const draining=f.queue.drain(1); await ready; f.queue.remove(1); resolve(); await draining;
  assert.equal(f.store.get(1),undefined); assert.equal(f.queue.nextAlarm(),null);
});
test('compaction checkpoint makes the canonical backlog due without replacing originals',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'raw before compaction'); f.queue.checkpoint(1);
  await f.queue.drain(); assert.equal(f.calls.length,1); assert.ok(f.calls[0].messages[0].content.includes('raw before compaction'));
});
test('malformed Unicode is not submitted or acknowledged',async()=>{
  const f=fixture(); f.queue.enroll(1,null); f.add(1,0,'invalid\ud800'); f.tick(); await f.queue.drain();
  assert.equal(f.calls.length,0); assert.equal(f.queue.status(1).acknowledgedThrough,-1); assert.equal(f.queue.status(1).state,'retrying');
});
test('missing source never silently skips a sequence',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot',2); f.add(1,1,'second without first'); f.tick(); await f.queue.drain();
  assert.equal(f.calls.length,0); assert.equal(f.queue.status(1).acknowledgedThrough,-1); assert.equal(f.queue.status(1).state,'retrying');
});
test('missing binding preserves a durable retry backlog',async()=>{
  const f=fixture({binding:undefined}); f.queue.enroll(1,'bot'); f.add(1,0,'must remain'); f.tick(); await f.queue.drain();
  assert.equal(f.queue.status(1).state,'retrying'); assert.equal(f.queue.status(1).acknowledgedThrough,-1);
});
test('namespace changes do not retarget existing records',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'original');
  f.deps.namespace='different'; f.restart(); f.tick(); await f.queue.drain();
  assert.equal(f.calls.length,0); assert.equal(f.queue.status(1).acknowledgedThrough,-1);
});
test('revocation after a failed request blocks replay of its frozen batch',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'protected'); f.fail(true); f.tick(); await f.queue.drain();
  f.fail(false); f.deny(true); f.tick(4_000_000); await f.queue.drain();
  assert.equal(f.calls.length,1); assert.equal(f.queue.status(1).acknowledgedThrough,-1);
});
test('recall uses the bot profile and rejects oversized queries instead of clipping',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot-a');
  assert.equal((await f.queue.recall(1,'내 프로젝트')).answer,'내 프로젝트');
  assert.equal(f.profiles[0],await memoryProfileName(f.deps.principal,'bot-a'));
  await assert.rejects(()=>f.queue.recall(1,'가'.repeat(342)),/1024/);
  await assert.rejects(()=>f.queue.recall(99,'test'));
});
test('enrolling existing chat begins at original sequence zero',async()=>{
  const f=fixture(); f.add(1,0,'old original'); f.add(1,1,'newer original'); f.queue.enroll(1,'bot',2);
  await drainAll(f); assert.equal(f.queue.status(1).acknowledgedThrough,1);
  assert.ok(f.calls.flatMap(c=>c.messages).some(m=>JSON.parse(m.content).content==='old original'));
});
test('repeat enrollment cannot change a bot identity or reset progress',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot-a'); f.add(1,0,'one'); await drainAll(f);
  assert.throws(()=>f.queue.enroll(1,'bot-b'),/identity/);
  f.queue.enroll(1,'bot-a',1); assert.equal(f.queue.status(1).acknowledgedThrough,0);
});
test('concurrent drain calls are single flight',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'one'); f.tick();
  await Promise.all([f.queue.drain(),f.queue.drain()]); assert.equal(f.calls.length,1);
});

test('one idle batch carries consecutive conversation records together',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot');
  for(let sequence=0;sequence<6;sequence++) f.add(1,sequence,`turn ${sequence}`);
  f.tick(); await f.queue.drain(1);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].messages.length,6);
  assert.deepEqual(f.calls[0].messages.map(m=>JSON.parse(m.content).sequence),[0,1,2,3,4,5]);
  assert.equal(f.queue.status(1).acknowledgedThrough,5);
});
test('a failed local ACK after remote success retains the exact replay batch',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'durable original');
  const put=f.store.put; let failOnce=true;
  f.store.put=state=>{if(failOnce&&state.position.sequence===1){failOnce=false;throw new Error('disk failed');} return put(state);};
  f.tick(); await f.queue.drain(1);
  assert.equal(f.queue.status(1).acknowledgedThrough,-1);
  f.restart(); f.tick(4_000_000); await f.queue.drain(1);
  assert.deepEqual(f.calls[0],f.calls[1]);
  assert.equal(f.queue.status(1).acknowledgedThrough,0);
});

test('a page with a valid shape but a skipped prefix is never accepted',async()=>{
  const f=fixture(); f.queue.enroll(1,'bot'); f.add(1,0,'first character matters');
  const page=f.source.page;
  f.source.page=async(...args)=>{const value=await page(...args); return {...value,start:1,content:value.content.slice(1)};};
  f.tick(); await f.queue.drain();
  assert.equal(f.calls.length,0); assert.equal(f.queue.status(1).acknowledgedThrough,-1);
});
