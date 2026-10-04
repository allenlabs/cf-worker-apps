import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeContext, makeEnv, makeBatch } from './helpers.js';
import { gunzip } from '../src/util.js';
const { TelemetryJournal } = await import('../src/journal.js').catch(() => ({}));
const create = (env = makeEnv(), ctx = makeContext()) => ({ env, ctx, j: new TelemetryJournal(ctx, env) });
test('journal class exists', () => assert.equal(typeof TelemetryJournal, 'function'));
test('acceptance is durable before R2 flush and survives object reconstruction', async () => {
    const { env, ctx, j } = create();
    const b = makeBatch();
    await j.ingest(b);
    assert.equal(env.ARCHIVE.objects.size, 0);
    const next = new TelemetryJournal(ctx, env);
    assert.equal(next.health().pendingBatches, 1);
    assert.ok(await ctx.storage.getAlarm());
});
test('flush writes a compressed segment and manifest, then removes pending rows', async () => {
    const { env, j } = create();
    await j.ingest(makeBatch(3));
    await j.alarm();
    assert.equal(j.health().pendingBatches, 0);
    const segment = [...env.ARCHIVE.objects.entries()].find(([key]) => key.endsWith('.gz'));
    assert.ok(segment);
    const rows = new TextDecoder().decode(await gunzip(segment[1].bytes)).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].payload.length, 3);
    assert.equal([...env.ARCHIVE.objects.keys()].filter(k => k.startsWith('index/')).length, 1);
});
test('failed segment PUT retains all accepted payloads and schedules recovery', async () => {
    const { env, ctx, j } = create();
    await j.ingest(makeBatch());
    env.ARCHIVE.fail = (op, key) => op === 'put' && key.endsWith('.gz');
    await j.alarm();
    assert.equal(j.health().pendingBatches, 1);
    assert.ok(j.health().lastError);
    assert.ok(await ctx.storage.getAlarm());
    env.ARCHIVE.fail = null;
    await new TelemetryJournal(ctx, env).alarm();
    assert.equal(j.health().pendingBatches, 0);
});
test('manifest failure and restart reuse the exact same segment key', async () => {
    const { env, ctx, j } = create();
    await j.ingest(makeBatch());
    env.ARCHIVE.fail = (op, key) => op === 'put' && key.startsWith('index/');
    await j.alarm();
    const first = [...env.ARCHIVE.objects.keys()].find(k => k.endsWith('.gz'));
    assert.equal(j.health().pendingBatches, 1);
    await j.ingest(makeBatch());
    env.ARCHIVE.fail = null;
    await new TelemetryJournal(ctx, env).alarm();
    const puts = env.ARCHIVE.calls.filter(([op, key]) => op === 'put' && key.endsWith('.gz')).map(x => x[1]);
    assert.equal(puts[0], first);
    assert.equal(puts[1], first);
});
test('empty alarms cause no R2 requests', async () => {
    const { env, j } = create();
    await j.alarm();
    assert.equal(env.ARCHIVE.calls.length, 0);
});
test('explicit idempotency key returns prior receipt without duplicating rows', async () => {
    const { j } = create();
    const b = makeBatch();
    const a = await j.ingest(b, 'same-key');
    const c = await j.ingest({ ...b, id: crypto.randomUUID() }, 'same-key');
    assert.equal(a.batchId, c.batchId);
    assert.equal(c.duplicate, true);
    assert.equal(j.health().pendingBatches, 1);
});
test('reusing an idempotency key with another payload is rejected', async () => {
    const { j } = create();
    await j.ingest(makeBatch(1), 'same-key');
    await assert.rejects(() => j.ingest(makeBatch(2), 'same-key'), e => e.status === 409);
});
test('overloaded journal returns 503 without accepting or dropping a batch', async () => {
    const { j } = create(makeEnv({ MAX_PENDING_BYTES: '1024' }));
    const b = makeBatch(1, Date.now(), { payload: [{ message: 'x'.repeat(1500) }] });
    await assert.rejects(() => j.ingest(b), e => e.status === 503);
    assert.equal(j.health().pendingBatches, 0);
});
test('batches spanning different UTC hours are not put under the wrong manifest', async () => {
    const { env, j } = create();
    const hour = Date.UTC(2026, 8, 8, 2);
    await j.ingest(makeBatch(1, hour + 3599000));
    await j.ingest(makeBatch(1, hour + 3600100));
    await j.alarm();
    await j.alarm();
    assert.equal([...env.ARCHIVE.objects.keys()].filter(k => k.startsWith('index/')).length, 2);
});
test('accepted live frames have no raw fields and expired viewers are closed', async () => {
    const { ctx, j } = create();
    const frames = [];
    let expired = false;
    ctx.acceptWebSocket({ deserializeAttachment: () => ({ exp: Date.now() + 100000 }), send: s => frames.push(JSON.parse(s)), close: () => {
        } });
    ctx.acceptWebSocket({ deserializeAttachment: () => ({ exp: 1 }), send: () => assert.fail('expired connection received data'), close: () => {
            expired = true;
        } });
    await j.ingest(makeBatch(2));
    assert.equal(frames[0].events.length, 2);
    assert.equal(frames[0].events[0].raw, undefined);
    assert.ok(expired);
});
test('live subscriptions filter nested raw fields before creating safe previews', async () => {
    const { ctx, j } = create();
    const frames = [];
    ctx.acceptWebSocket({ deserializeAttachment: () => ({ exp: Date.now() + 100000, filters: { q: 'needle', service: 'test-service' } }), send: s => frames.push(JSON.parse(s)), close: () => {
        } });
    await j.ingest(makeBatch(1, Date.now(), { payload: [{ service: 'test-service', message: 'not visible' }, { service: 'test-service', message: 'match', attributes: { value: 'needle' } }] }));
    assert.equal(frames[0].events.length, 1);
    assert.equal(frames[0].events[0].message, 'match');
});
test('large service attributes do not expand every archive manifest', async () => {
    const { env, j } = create();
    await j.ingest(makeBatch(1, Date.now(), { payload: [{ service: 's'.repeat(10000), message: 'bounded index' }] }));
    await j.alarm();
    const object = [...env.ARCHIVE.objects.entries()].find(([key]) => key.startsWith('index/'))[1];
    const manifest = JSON.parse(new TextDecoder().decode(object.bytes));
    assert.equal(manifest.segments[0].services, null);
    assert.ok(object.bytes.length < 2000);
});
test('no live success is emitted before storage synchronization', async () => {
    const { ctx, j } = create();
    const sent = [];
    ctx.storage.sync = async () => {
        throw new Error('Injected durable synchronization failure');
    };
    ctx.acceptWebSocket({ deserializeAttachment: () => ({ exp: Date.now() + 10000 }), send: s => sent.push(s), close: () => {
        } });
    await assert.rejects(() => j.ingest(makeBatch()), /synchronization/);
    assert.equal(sent.length, 0);
});
test('idempotency receipt remains valid after raw data moves to R2', async () => {
    const { j } = create();
    const b = makeBatch();
    const first = await j.ingest(b, 'archive-retry');
    await j.alarm();
    const retry = await j.ingest({ ...b, id: crypto.randomUUID() }, 'archive-retry');
    assert.equal(first.batchId, retry.batchId);
    assert.equal(retry.duplicate, true);
    assert.equal(j.health().pendingBatches, 0);
});
