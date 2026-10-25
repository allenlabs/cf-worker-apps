import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/native-memory-host.ts') && specifier==='./native-memory') return next('./native-memory.ts',context);
  return next(specifier,context);
}});
const { createMemorySource } = await import('../overlay/packages/workshop-backend/src/native-memory-host.ts');
function host(record) {
  const calls=[];
  return { calls,
    assertAccess:()=>{}, record:()=>record,
    history:async()=>({sequence:record.sequence,page:{artifactId:'a'.repeat(64),cursor:'first'}}),
    readText:async(...args)=>{calls.push(args);return {content:'page'};},
    archive:async(_chat,text)=>{calls.push(['archive',text]);return {id:'c'.repeat(64),startCursor:'text-first'};},
    attachment:async()=>new TextEncoder().encode('\ufeff가나다🙂\nlast'),
    isTextAttachment:mime=>mime==='text/plain',
  };
}
test('source snapshots original record and full archived outputs, not a compaction summary',async()=>{
  const record={sequence:0,type:'message',timestamp:new Date('2026-10-25'),author:{type:'agent'},toolCalls:[{archivedOutput:{id:'b'.repeat(64)}},{sourceArtifactId:'b'.repeat(64)}]};
  const h=host(record); const source=createMemorySource(h);
  const snapshot=await source.load(1,0,'owner');assert.equal(snapshot.role,'assistant');assert.equal(snapshot.sources.length,2);
  assert.equal(snapshot.sources[0].id,'a'.repeat(64));assert.equal(snapshot.sources[1].id,'b'.repeat(64));
  await source.authorize(1,snapshot,'owner');assert.equal(h.calls.length,2);
});
test('text attachments preserve BOM and Unicode; binary is a reference, not fabricated extracted text',async()=>{
  const record={sequence:0,type:'message',timestamp:new Date('2026-10-25'),author:{type:'user'},attachments:[{id:'txt',mimeType:'text/plain'},{id:'png',mimeType:'image/png'}]};
  const h=host(record); const snapshot=await createMemorySource(h).load(1,0,'owner');
  assert.equal(snapshot.sources.length,2);assert.deepEqual(h.calls[0],['archive','\ufeff가나다🙂\nlast']);
});
test('reading recovery pages does not ingest the entire source artifact again for every page', async () => {
  const record = { sequence: 1, type: 'message', timestamp: new Date('2026-10-25'), author: { type: 'agent' },
    toolCalls: [
      { toolName: 'readStoredText', sourceArtifactId: 'b'.repeat(64) },
      { toolName: 'readChatHistory', sourceArtifactId: 'c'.repeat(64) },
    ] };
  const snapshot = await createMemorySource(host(record)).load(1, 1, 'owner');
  assert.deepEqual(snapshot.sources.map(source => source.label), ['chat-record']);
});
test('invalid UTF-8 attachments fail visibly rather than replacing bytes',async()=>{
  const record={sequence:0,type:'message',timestamp:new Date('2026-10-25'),author:{type:'user'},attachments:[{id:'txt',mimeType:'text/plain'}]};
  const h=host(record);h.attachment=async()=>Uint8Array.from([0xc3,0x28]);
  await assert.rejects(()=>createMemorySource(h).load(1,0,'owner'));
});
test('denied source never produces a snapshot',async()=>{
  const h=host({});h.assertAccess=()=>{throw new Error('denied');};
  await assert.rejects(()=>createMemorySource(h).load(1,0,'other'),/denied/);assert.equal(h.calls.length,0);
});
