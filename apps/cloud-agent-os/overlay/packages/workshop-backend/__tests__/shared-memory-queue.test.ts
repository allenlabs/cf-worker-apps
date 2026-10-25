// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NativeMemoryQueue, memoryProfileName, commonMemoryProfileName, type MemoryMessage } from '../src/native-memory';

const BOT='11111111-1111-4111-8111-111111111111';
const ID='a'.repeat(64);
function setup() {
  let time=1000, fail=false;
  const stored=new Map<number, any>();
  const text='한국어 👨‍👩‍👧‍👦 '+JSON.stringify({body:'🐣'.repeat(4000),end:'마지막 끝'});
  const calls:Array<{name:string;messages:MemoryMessage[];sessionId:string}>=[];
  const deps={
    principal:'owner@example.invalid',namespace:'memory-testing',workspaceId:'test-workspace',
    // An old caller must not re-enable the removed transcript-copy behavior.
    commonProfile:true,now:()=>time,
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
        if(end<text.length && text.charCodeAt(end-1)>=0xd800 && text.charCodeAt(end-1)<=0xdbff) end--;
        const eof=end===text.length;
        return {artifactId:ID,sha256:ID,start,end,totalChars:text.length,totalBytes:new TextEncoder().encode(text).byteLength,
          content:text.slice(start,end),nextCursor:eof?null:JSON.stringify({offset:end}),eof};
      },
      async authorize(){},
    },
    binding:{async getProfile(name:string) {return {
      async ingest(messages:MemoryMessage[],{sessionId}:{sessionId:string}) {
        calls.push({name,messages:structuredClone(messages),sessionId});
        if(fail) throw new Error('Transient ingest failure');
      },
      async recall(){return {count:0,answer:'',candidates:[]};},
    };}},
  };
  let queue=new NativeMemoryQueue(deps);
  return {text,calls,deps,stored,get queue(){return queue;},tick:(ms=60_000)=>{time+=ms;},
    fail:(value:boolean)=>{fail=value;},
    restart:()=>{queue=new NativeMemoryQueue(deps);},
    async flush(){for(let i=0;i<150 && queue.nextAlarm()!==null;i++){time+=4_000_000;await queue.drain();}expect(queue.nextAlarm()).toBeNull();},
  };
}
describe('owner common context and separate bot memory',()=>{
  it('sends the entire UTF-8 bot chat only to its original per-bot profile',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);await f.flush();
    const privateName=await memoryProfileName(f.deps.principal,BOT);
    const sharedName=await commonMemoryProfileName(f.deps.principal);
    expect(new Set(f.calls.map(call=>call.name))).toEqual(new Set([privateName]));
    expect(privateName).not.toBe(sharedName);
    const pieces=f.calls.flatMap(call=>call.messages.map(message=>JSON.parse(message.content)));
    expect(pieces.map(piece=>piece.content).join('')).toBe(f.text);
    expect(pieces.at(-1).eof).toBe(true);
    expect(pieces[0].botId).toBe(BOT);
    expect(f.queue.status(1)).toMatchObject({state:'caught-up',acknowledgedThrough:0});
    expect(f.stored.get(1).commonPosition).toBeUndefined();
  });
  it('resumes byte-identical frozen bot data after a failed request and restart',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);f.fail(true);f.tick();await f.queue.drain(1);
    expect(f.queue.status(1).acknowledgedThrough).toBe(-1);
    const original=structuredClone(f.calls[0]);
    f.restart();f.fail(false);await f.flush();
    expect(f.calls[1]).toEqual(original);
    expect(f.calls.every(call=>call.name===original.name)).toBe(true);
    expect(f.queue.status(1).state).toBe('caught-up');
  });
  it('never backfills existing completed bot chats into common context',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);await f.flush();
    const oldCount=f.calls.length;
    f.restart();f.queue.enroll(1,BOT,1);await f.flush();
    expect(f.calls.length).toBe(oldCount);
    expect(f.queue.status(1).acknowledgedThrough).toBe(0);
    expect(f.stored.get(1).commonPosition).toBeUndefined();
  });
  it('reports legacy common copies as paused and keeps their frozen payload intact',async()=>{
    const f=setup();f.queue.enroll(1,BOT,1);await f.flush();
    const state=f.stored.get(1);
    const commonPending={id:'legacy-batch',snapshots:[],messages:[{role:'user',content:'saved legacy text',timestamp:'2026-10-25T00:00:00.000Z'}],after:{sequence:1,sourceIndex:0}};
    Object.assign(state,{commonPosition:{sequence:0,sourceIndex:0},commonPending,dueAt:0,attempts:2,lastError:'Legacy common failure'});
    const count=f.calls.length;
    f.restart();await f.flush();
    expect(f.calls.length).toBe(count);
    expect(f.stored.get(1).commonPending).toEqual(commonPending);
    expect(f.queue.status(1)).toMatchObject({state:'caught-up',commonSharing:'paused',commonBacklog:1});
  });
});
