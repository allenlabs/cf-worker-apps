import { test, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { hourPath } from '../../src/util.js';
test('deployed API shape uses real R2 LIST and protects archive inspection with viewer auth',async()=>{
    const hour=Date.UTC(2025,0,1), marker=crypto.randomUUID();
    const origin='https://observe.test';
    const url=`${origin}/api/archive/check?hour=${hour}`;
    expect((await exports.default.fetch(url)).status).toBe(401);
    expect((await exports.default.fetch(url,{headers:{authorization:`Bearer ${env.INGEST_TOKEN}`}})).status).toBe(401);
    const key=`segments/${env.DATASET}/${hourPath(hour)}/${marker}.ndjson.gz`;
    await env.ARCHIVE.put(key,'synthetic inspection fixture');
    const response=await exports.default.fetch(url,{headers:{authorization:`Bearer ${env.VIEWER_TOKEN}`}});
    expect(response.status).toBe(200);
    const report=await response.json();
    expect(report.status).toBe('warning');
    expect(report.unindexed).toContain(key);
    expect(report.manifestPresent).toBe(false);
    expect(await env.ARCHIVE.get(key)).not.toBeNull();
});
