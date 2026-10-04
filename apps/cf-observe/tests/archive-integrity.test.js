import { test, expect } from 'vitest';
import { makeEnv, MemoryR2 } from './helpers.js';
import { hourPath } from '../src/util.js';
const { inspectArchive } = await import('../src/archive-integrity.js').catch(() => ({}));
const hour = Date.UTC(2026, 8, 7, 0);
const prefix = `segments/test/${hourPath(hour)}/`;
const index = `index/test/${hourPath(hour)}.json`;
class ListedR2 extends MemoryR2 {
  async list({ prefix, limit }) {
    const objects = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({key}));
    return { objects: objects.slice(0,limit), truncated: objects.length > limit };
  }
}
function setup() { return makeEnv({ ARCHIVE: new ListedR2() }); }
async function manifest(env, entries) {
  await env.ARCHIVE.put(index, JSON.stringify({ version:1,hour,segments:entries }));
}
test('archive inspection has a bounded read-only entrypoint', () => expect(typeof inspectArchive).toBe('function'));
test('empty hour differs from a missing manifest with existing raw objects', async () => {
  const env=setup();
  expect((await inspectArchive(env,{hour})).status).toBe('empty');
  await env.ARCHIVE.put(prefix+'1.ndjson.gz','raw');
  const report=await inspectArchive(env,{hour});
  expect(report.status).toBe('warning');
  expect(report.manifestPresent).toBe(false);
  expect(report.unindexed).toEqual([prefix+'1.ndjson.gz']);
});
test('healthy archive and missing referenced segment are distinguishable without writes', async () => {
  const env=setup();
  const entry={key:prefix+'1.ndjson.gz',firstSeq:1,lastSeq:2};
  await env.ARCHIVE.put(entry.key,'raw');
  await manifest(env,[entry]);
  const writes=env.ARCHIVE.calls.filter(x=>x[0]==='put').length;
  expect((await inspectArchive(env,{hour})).status).toBe('healthy');
  env.ARCHIVE.objects.delete(entry.key);
  const report=await inspectArchive(env,{hour});
  expect(report.missing).toEqual([entry.key]);
  expect(report.status).toBe('warning');
  expect(env.ARCHIVE.calls.filter(x=>x[0]==='put').length).toBe(writes);
});
test('truncated listing is incomplete and cannot claim absent segments', async () => {
  const env=setup();
  for(let i=0;i<1001;i++)await env.ARCHIVE.put(prefix+i+'.ndjson.gz','r');
  await manifest(env,[{key:prefix+'999.ndjson.gz',firstSeq:1,lastSeq:1}]);
  const report=await inspectArchive(env,{hour});
  expect(report.status).toBe('incomplete');
  expect(report.listedSegments).toBe(1000);
  expect(report.missing).toEqual([]);
  expect(report.complete).toBe(false);
});
test('cross-dataset references, overlapping seq ranges and invalid manifests are reported', async () => {
  const env=setup();
  await manifest(env,[{key:'segments/other/private.ndjson.gz',firstSeq:1,lastSeq:5},{key:prefix+'2.ndjson.gz',firstSeq:4,lastSeq:6}]);
  const report=await inspectArchive(env,{hour});
  expect(report.invalid.length).toBeGreaterThan(0);
  expect(report.status).toBe('warning');
  await env.ARCHIVE.put(index,'broken JSON');
  expect((await inspectArchive(env,{hour})).invalid).toContain('Manifest is not valid JSON');
});
test('malformed or future hour is rejected before R2 requests', async () => {
  const env=setup();
  for(const value of ['bad','',String(Date.now()+7200000)])await expect(inspectArchive(env,{hour:value})).rejects.toMatchObject({status:400});
  expect(env.ARCHIVE.calls).toEqual([]);
});
test('active hour explicitly warns that publication can be in progress', async () => {
  const env=setup();
  const report=await inspectArchive(env,{hour:Date.now()});
  expect(report.activeHour).toBe(true);
  expect(report.advice).toMatch(/publication/);
});
test('falsy JSON values cannot masquerade as a healthy manifest', async () => {
  const env=setup();
  for(const value of [null,false,0,'']) {
    await env.ARCHIVE.put(index,JSON.stringify(value));
    expect((await inspectArchive(env,{hour})).status).toBe('warning');
  }
});
