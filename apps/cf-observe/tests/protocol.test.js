import { test } from 'vitest';
import assert from 'node:assert/strict';
const p = await import('../src/protocol.js').catch(() => ({}));
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] };
const stamp = '1788844200123456789';
const batch = (signal, payload) => ({ id: 'batch-a', seq: 1, receivedAt: 1788844200200, signal, payload });
test('protocol module exposes normalize', () => assert.equal(typeof p.normalize, 'function'));
test('OTLP log preserves original nanoseconds, body, unknown fields and resource', () => {
    const payload = { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'sdk' }, logRecords: [{ timeUnixNano: stamp, severityNumber: 17, body: { stringValue: 'failed' }, novelField: { ok: 1 } }] }] }] };
    const [e] = p.normalize(batch('logs', payload));
    assert.equal(e.service, 'checkout');
    assert.equal(e.timestamp, 1788844200123);
    assert.equal(e.severity, 'ERROR');
    assert.equal(e.raw.record.timeUnixNano, stamp);
    assert.deepEqual(e.raw.record.novelField, { ok: 1 });
    assert.deepEqual(e.raw.resource, resource);
});
test('trace duration does not round timestamps before subtracting', () => {
    const [e] = p.normalize(batch('traces', { resourceSpans: [{ resource, scopeSpans: [{ spans: [{ name: 'POST /order', startTimeUnixNano: stamp, endTimeUnixNano: '1788844200124456790', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), status: { code: 2 } }] }] }] }));
    assert.equal(e.durationMs, 1.000001);
    assert.equal(e.traceId, 'a'.repeat(32));
    assert.equal(e.severity, 'ERROR');
});
test('every metric point is exposed and histogram buckets remain intact', () => {
    const metric = { name: 'http.duration', unit: 's', histogram: { aggregationTemporality: 2, dataPoints: [{ timeUnixNano: stamp, count: '3', sum: 1.2, explicitBounds: [0.1, 0.5], bucketCounts: ['1', '1', '1'] }, { timeUnixNano: stamp, count: '1', sum: 0.9 }] } };
    const es = p.normalize(batch('metrics', { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [metric] }] }] }));
    assert.equal(es.length, 2);
    assert.deepEqual(es[0].raw.point.bucketCounts, ['1', '1', '1']);
    assert.equal(es[0].metricType, 'histogram');
});
test('generic events preserve their full payload', () => {
    const data = { service: 'worker', message: 'hello', payload: { nested: ['a', 2] } };
    assert.deepEqual(p.normalize(batch('events', [data]))[0].raw, data);
});
test('invalid top-level OTLP container is rejected, not silently accepted empty', () => {
    assert.throws(() => p.normalize(batch('logs', { typoResourceLogs: [] })), /resourceLogs/);
});
test('valid empty OTLP request is accepted', () => assert.deepEqual(p.normalize(batch('logs', {})), []));
test('preview does not contain sensitive raw attributes and marks abbreviated messages', () => {
    const [e] = p.normalize(batch('events', [{ message: 'x'.repeat(5000), secret: 'do-not-send-in-list' }]));
    const preview = p.preview(e);
    assert.equal(preview.raw, undefined);
    assert.ok(preview.message.length <= 2048);
    assert.equal(preview.messageTruncated, true);
});
test('protobuf reader preserves uint64 precision and handles packed histogram counts', async () => {
    assert.equal(typeof p.decodeBody, 'function');
    const { encodeFixture } = await import('./protobuf-fixtures.js');
    const data = encodeFixture('logs', stamp);
    const decoded = await p.decodeBody(new Request('http://test/v1/logs', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: data }), 'logs');
    const [e] = p.normalize(batch('logs', decoded.payload));
    assert.equal(e.raw.record.timeUnixNano, stamp);
    assert.equal(e.message, 'binary log');
    assert.ok(decoded.wireBase64);
});
test('previews bound large display fields without changing the raw request', () => {
    const [e] = p.normalize(batch('events', [{ service: 's'.repeat(10000), message: 'm'.repeat(10000), value: { large: 'z'.repeat(10000) } }]));
    const view = p.preview(e);
    assert.ok(view.service.length <= 256);
    assert.ok(view.message.length <= 2048);
    assert.ok(JSON.stringify(view).length < 5000);
    assert.equal(e.raw.service.length, 10000);
});
test('OTLP packed histogram counts retain 64-bit precision', async () => {
    const { concat, message, string, fixed64 } = await import('./protobuf-fixtures.js');
    const raw64 = n => fixed64(1, n).slice(1);
    const double = n => {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, n, true);
        return b;
    };
    const point = concat(fixed64(3, stamp), fixed64(4, 9007199254740993n), message(6, concat(raw64(9007199254740992n), raw64(1n))), message(7, double(10)));
    const metric = concat(string(1, 'response.duration'), message(9, message(1, point)));
    const bytes = message(1, message(2, message(2, metric)));
    const decoded = await p.decodeBody(new Request('https://test/v1/metrics', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: bytes }), 'metrics');
    const [event] = p.normalize({ ...batch('metrics', decoded.payload), ...decoded });
    assert.equal(event.metricType, 'histogram');
    assert.deepEqual(event.raw.point.bucketCounts, ['9007199254740992', '1']);
    assert.deepEqual(event.raw.point.explicitBounds, [10]);
    assert.equal(event.raw.point.count, '9007199254740993');
    assert.ok(decoded.wireBase64);
});
