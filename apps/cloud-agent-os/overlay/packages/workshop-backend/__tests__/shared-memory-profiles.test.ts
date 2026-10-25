// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readMainBot, setMainBot, clearArchivedMainBot } from '../src/main-bot';
import { selectMemorySources, searchMemoryProfiles } from '../src/memory-sharing';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';
const bots=[{id:A,name:'Main',archived:false},{id:B,name:'Research',archived:false},{id:C,name:'Archive',archived:true}];

describe('account main bot',()=>{
  const map=new Map();
  const store={get:(key:'main')=>map.get(key),put:(value:any)=>map.set(value.key,structuredClone(value))};
  const owned=new Map(bots.map(b=>[b.id,b]));
  it('starts with Standard and stores exactly one revisioned pointer',()=>{
    map.clear();
    expect(readMainBot(store)).toEqual({key:'main',botId:null,revision:0});
    expect(setMainBot(store,owned,A,0)).toEqual({key:'main',botId:A,revision:1});
    expect(setMainBot(store,owned,B,1)).toEqual({key:'main',botId:B,revision:2});
    expect(map.size).toBe(1);
  });
  it('rejects stale writes, unknown/archived choices and preserves idempotent retries',()=>{
    map.clear();setMainBot(store,owned,A,0);
    expect(setMainBot(store,owned,A,0)).toEqual(readMainBot(store));
    expect(()=>setMainBot(store,owned,B,0)).toThrow(/changed/);
    expect(()=>setMainBot(store,owned,'99999999-9999-4999-8999-999999999999',1)).toThrow(/unavailable/);
    expect(()=>setMainBot(store,owned,C,1)).toThrow(/Archived/);
  });
  it('clears archived main without changing the previous chat snapshot or other profile',()=>{
    map.clear();setMainBot(store,owned,A,0);
    expect(clearArchivedMainBot(store,B).botId).toBe(A);
    expect(clearArchivedMainBot(store,A).botId).toBe(null);
    expect(readMainBot(store).revision).toBe(2);
  });
});

describe('memory profile fanout',()=>{
  it('uses self plus common by default',()=>{
    expect(selectMemorySources(A,bots).map(x=>x.kind)).toEqual(['bot','common']);
  });
  it('adds only authorized selected bots, including archived ones',()=>{
    expect(selectMemorySources(A,bots,{scope:'selected',botIds:[B,C]}).map(x=>x.botId)).toEqual([A,null,B,C]);
    expect(()=>selectMemorySources(A,bots,{scope:'selected',botIds:['99999999-9999-4999-8999-999999999999']})).toThrow(/not available/);
  });
  it('includes Standard assistant and every bot for all scope and refuses hidden truncation',()=>{
    expect(selectMemorySources(A,bots,{scope:'all'}).map(x=>x.kind)).toEqual(['bot','common','bot','bot','standard']);
    const many=Array.from({length:65},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,name:`Bot ${i}`,archived:false}));
    expect(()=>selectMemorySources(A,many,{scope:'all'})).toThrow(/too many/i);
  });
  it('reports partial failures and source provenance rather than hiding a failed bot',async()=>{
    const searched:string[]=[];
    const result=await searchMemoryProfiles({
      principal:'owner@example.invalid',currentBotId:A,bots,query:'하나의 조사',
      options:{scope:'selected',botIds:[B]},
      profileName:async id=>`bot:${id}`,commonName:async()=> 'common',
      binding:{async getProfile(name){searched.push(name);return {async recall(){
        if(name===`bot:${B}`)throw Error('private synthetic error');
        return {count:1,answer:name,candidates:[]};
      }};}},
    });
    expect(result.complete).toBe(false);
    expect(result.sources).toHaveLength(3);
    expect(result.sources[2].error).toBe('Memory lookup failed');
    expect(JSON.stringify(result)).not.toContain('private synthetic');
    expect(searched).toHaveLength(3);
  });
  it('rejects invalid/out-of-budget query without querying the provider',async()=>{
    let count=0;
    const props={principal:'owner',currentBotId:A,bots,options:{scope:'all' as const},profileName:async()=> 'bot',commonName:async()=> 'common',
      binding:{async getProfile(){count++;throw Error('unreachable');}}};
    await expect(searchMemoryProfiles({...props,query:'가'.repeat(342)})).rejects.toThrow(/1024/);
    await expect(searchMemoryProfiles({...props,query:'\uD800'})).rejects.toThrow(/Unicode/);
    expect(count).toBe(0);
  });
});
