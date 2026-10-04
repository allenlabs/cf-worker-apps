import { test, expect } from 'vitest';
const { planTailConsumers, connectTail } = await import('../scripts/lib/tail-management.mjs').catch(() => ({}));
test('tail plan preserves existing consumers and is idempotent', () => {
    const existing=[{service:'other-tail',environment:'production'}];
    expect(planTailConsumers('hub-web','cf-observe-tail',existing)).toEqual([...existing,{service:'cf-observe-tail'}]);
    expect(planTailConsumers('hub-web','cf-observe-tail',[...existing,{service:'cf-observe-tail'}])).toEqual([...existing,{service:'cf-observe-tail'}]);
    expect(existing).toHaveLength(1);
});
test('collector and receiver cannot be configured as producers', () => {
    for(const producer of ['cf-observe','cf-observe-tail']) expect(()=>planTailConsumers(producer,'cf-observe-tail',[])).toThrow(/recursive/);
    expect(()=>planTailConsumers('valid','../../invalid',[])).toThrow(/name/);
});
test('dry run reads exact settings but never patches', async () => {
    const calls=[];
    const api=async(path,options)=>{calls.push({path,options});return {tail_consumers:[{service:'other-tail'}],observability:{enabled:true}};};
    const report=await connectTail(api,'hub-web','cf-observe-tail',false);
    expect(report.changed).toBe(true);
    expect(report.applied).toBe(false);
    expect(calls).toHaveLength(1);
    expect(report.before).toEqual([{service:'other-tail'}]);
});
test('apply changes only tail consumers, preserves other settings and verifies returned state', async () => {
    const calls=[];
    const api=async(path,options)=>{
        calls.push({path,options});
        return options ? {tail_consumers:options.body.tail_consumers} : {tail_consumers:[{service:'other-tail'}],observability:{enabled:true}};
    };
    const report=await connectTail(api,'hub-web','cf-observe-tail',true);
    expect(report.applied).toBe(true);
    expect(calls[1].options).toEqual({method:'PATCH',body:{tail_consumers:[{service:'other-tail'},{service:'cf-observe-tail'}]}});
});
test('API failures are surfaced without retrying mutations or overwriting consumers', async () => {
    let count=0;
    const api=async()=>{count++;throw new Error('upstream unavailable');};
    await expect(connectTail(api,'hub-web','cf-observe-tail',true)).rejects.toThrow('upstream unavailable');
    expect(count).toBe(1);
});
