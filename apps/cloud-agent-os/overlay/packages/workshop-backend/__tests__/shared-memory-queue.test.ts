// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NativeMemoryQueue, memoryProfileName, commonMemoryProfileName, type MemoryMessage } from '../src/native-memory';

const BOT='11111111-1111-4111-8111-111111111111';
const ID='a'.repeat(64);
function setup(commonProfile = true) {
  let time=1000, failCommon=false;
  const stored=new Map<number, any>();
  const text='한국어 👨‍👩‍👧‍👦 '+JSON.stringify({body:'🐣'.repeat(4000),end:'마지막 끝'});
  const calls:Array<{name:string;messages:MemoryMessage[];sessionId:string}>=[];
  const deps={
    principal:'owner@example.invalid',namespace:'memory-testing',workspaceId:'test-workspace',
    commonProfile,now:()=>time,
    store:{
      get:(id:number)=>stored.has(id)?structuredClone(stored.get(id)):undefined,
      put:(value:any)=>{stored.set(value.chatId,structuredClone(value));},
      delete:(id:number)=>{stored.delete(id);},
      list:()=>[...stored.values()].map(value=>structuredClone(value)),
      transaction:<T>(callback:()=>T):T=>{
        const old=structuredClone(stored);
        try{return callback();}catch(error){stored.clear();for(const [key,value] of old)stored.set(key,value);throw error;}
      },
    },
    source:{
      async load(_chat:number,sequence:number) {
        if(sequence!==0)return null;
        return {sequence,role:'user' as const,timestamp:'2026-10-25T00:00:00.000Z',
          sources:[{id:ID,label:'chat-record'}]};
      },
      async page(_chat:number, _ref:{id:string},cursor?:string) {
        const start=cursor?JSON.parse(cursor).offset:0;
        let end=Math.min(text.length,start+1200);
        if(end<text.length && /[\\uD800-\\uDBFF]/.test(text[end-1])) end--;
        const eof=end===text.length;
        return {artifactId:ID,sha256:ID,start,end,totalChars:text.length,totalBytes:new TextEncoder().encode(text).byteLength,
          content:text.slice(start,end),nextCursor:eof?null:JSON.stringify({offset:end}),eof};
      },
      async authorize(){},
    },
    binding:{async getProfile(name:string) {return {
      async ingest(messages:MemoryMessage[],{sessionId}:{sessionId:string}) {
        calls.push({name,messages:structuredClone(messages),sessionId});
        if(failCommon && name.startsWith('common-')) throw new Error('Transient shared failure');
      },
      async recall(){return {count:0,answer:'',candidates:[]};},
    };}},
  };
  let queue=new NativeMemoryQueue(deps);
  return {text,calls,deps,stored,get queue(){return queue;},tick:(ms=60_000)=>{time+=ms;},
    failCommon:(value:boolean)=>{failCommon=value;},
    restart:(shared=commonProfile)=>{deps.commonProfile=shared;queue=new NativeMemoryQueue(deps);},
    async flush(){for(let i=0;i<150 && queue.nextAlarm()!==null;i++){time+=4_000_000;await queue.drain();}expect(queue.nextAlarm()).toBeNull();},
  };
}
describe('shared Agent Memory and immutable bot memory',()=>{
  it('sends the same entire UTF-8 chat to private and common profiles independently',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);await f.flush();
    const privateName=await memoryProfileName(f.deps.principal,BOT);
    const sharedName=await commonMemoryProfileName(f.deps.principal);
    expect(new Set(f.calls.map(call=>call.name))).toEqual(new Set([privateName,sharedName]));
    for(const name of [privateName,sharedName]){
      const pieces=f.calls.filter(call=>call.name===name).flatMap(call=>call.messages.map(message=>JSON.parse(message.content)));
      expect(pieces.map(piece=>piece.content).join('')).toBe(f.text);
      expect(pieces.at(-1).eof).toBe(true);
      expect(pieces[0].botId).toBe(BOT);
    }
    expect(f.queue.status(1)).toMatchObject({state:'caught-up',acknowledgedThrough:0,commonAcknowledgedThrough:0,commonBacklog:0});
  });
  it('does not replay acknowledged bot data when the common destination fails and retries',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);f.failCommon(true);
    for(let i=0;i<40 && !f.calls.some(call=>call.name.startsWith('common-'));i++){
      f.tick(4_000_000);await f.queue.drain();
    }
    expect(f.calls.some(call=>call.name.startsWith('common-'))).toBe(true);
    expect(f.queue.status(1).acknowledgedThrough).toBe(0);
    expect(f.queue.status(1).commonAcknowledgedThrough).toBe(-1);
    const original=f.calls.filter(c=>c.name.startsWith('common-'))[0];
    f.restart();f.failCommon(false);await f.flush();
    const privateCalls=f.calls.filter(c=>c.name.startsWith('bot-'));
    expect(privateCalls.length).toBeGreaterThan(0);
    expect(f.calls.filter(c=>c.name.startsWith('common-'))[1]).toEqual(original);
    expect(f.queue.status(1).state).toBe('caught-up');
  });
  it('backfills canonical sequence zero for existing private-only enrolled chats',async()=>{
    const f=setup(false);f.queue.enroll(1,BOT,1);await f.flush();
    const oldCount=f.calls.length;
    f.restart(true);f.queue.enroll(1,BOT,1);await f.flush();
    expect(f.calls.length).toBeGreaterThan(oldCount);
    expect(f.calls.slice(oldCount).every(c=>c.name.startsWith('common-'))).toBe(true);
    expect(f.queue.status(1).commonAcknowledgedThrough).toBe(0);
  });
});
