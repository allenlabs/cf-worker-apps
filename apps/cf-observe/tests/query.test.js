import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeContext, makeEnv, makeBatch, attachNamespace } from './helpers.js';
import { TelemetryJournal } from '../src/journal.js';
const { queryEvents, getEvent } = await import('../src/query.js').catch(() => ({}));
function setup() {
    const env = makeEnv(), j = new TelemetryJournal(makeContext(), env);
    attachNamespace(env, j);
    return { env, j };
}
const start = Date.UTC(2026, 8, 8, 2), params = { from: start, to: start + 3599999, limit: 3 };
test('query API exists', () => assert.equal(typeof queryEvents, 'function'));
test('all archived and pending events are paginated without duplication', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(5, start + 1000));
    await j.alarm();
    await j.ingest(makeBatch(4, start + 2000));
    const ids = [];
    let cursor;
    do {
        const page = await queryEvents(env, { ...params, cursor });
        ids.push(...page.events.map(e => e.id));
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 9);
    assert.equal(new Set(ids).size, 9);
});
test('pending-to-R2 transition during query has no gap', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(2, start + 1000));
    let fired = false;
    env.ARCHIVE.beforeGet = async (key) => {
        if (key.startsWith('index/') && !fired) {
            fired = true;
            await j.alarm();
        }
    };
    const p = await queryEvents(env, params);
    assert.equal(p.events.length, 2);
});
test('raw event detail can find a live preview after the batch moved to R2', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(1, start + 1000));
    const p = await queryEvents(env, params);
    await j.alarm();
    const detail = await getEvent(env, p.events[0]);
    assert.equal(detail.event.raw.message, 'event 0');
    assert.equal(detail.batch.payload.length, 1);
});
test('service and full-payload text filters find nested attributes', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(1, start + 1000, { payload: [{ service: 'api', message: 'quiet', attributes: { request_id: 'needle-123' } }] }));
    await j.alarm();
    const p = await queryEvents(env, { ...params, service: 'api', q: 'needle-123' });
    assert.equal(p.events.length, 1);
    const no = await queryEvents(env, { ...params, service: 'other' });
    assert.equal(no.events.length, 0);
    assert.equal(no.scanned.segments, 0);
});
test('a sparse broad query returns an explicit continuation, not a false complete', async () => {
    const { env } = setup();
    const p = await queryEvents(env, { from: start - 100 * 3600000, to: start, limit: 3 });
    assert.equal(p.complete, false);
    assert.ok(p.nextCursor);
    assert.equal(p.scanned.manifests, 24);
});
test('cursor tampering and changing filters are rejected', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(5, start + 1000));
    const p = await queryEvents(env, params);
    await assert.rejects(() => queryEvents(env, { ...params, cursor: p.nextCursor + 'x' }), e => e.status === 400);
    await assert.rejects(() => queryEvents(env, { ...params, q: 'changed', cursor: p.nextCursor }), e => e.status === 400);
});
test('a continuation uses a fixed watermark and excludes newly ingested records', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(5, start + 1000));
    const p = await queryEvents(env, params);
    await j.ingest(makeBatch(2, start + 1500));
    const second = await queryEvents(env, { ...params, cursor: p.nextCursor });
    assert.equal(second.events.length, 2);
    assert.ok(second.events.every(e => e.seq === 1));
});
test('missing archive segment produces a visible error, not silently missing logs', async () => {
    const { env, j } = setup();
    await j.ingest(makeBatch(1, start + 1000));
    await j.alarm();
    const key = [...env.ARCHIVE.objects.keys()].find(k => k.endsWith('.gz'));
    env.ARCHIVE.objects.delete(key);
    await assert.rejects(() => queryEvents(env, params), e => e.status === 502);
});
