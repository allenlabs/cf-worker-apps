import { HttpError, bytesLimited, gunzip, toBase64 } from './util.js';
import { decodeProtobuf } from './protobuf.js';
export const MAX_EVENTS = 2000;
function object(v, name) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new HttpError(400, `${name} must be an object`);
    return v;
}
function array(v, name) {
    if (v === undefined)
        return [];
    if (!Array.isArray(v))
        throw new HttpError(400, `${name} must be an array`);
    return v;
}
function ns(v, fallback) {
    if (v === undefined || v === '0' || v === 0)
        return fallback;
    try {
        if (typeof v === 'number' && !Number.isSafeInteger(v))
            throw 0;
        const n = BigInt(v);
        if (n < 0n)
            throw 0;
        const ms = Number(n / 1000000n);
        if (!Number.isFinite(ms) || ms > 8640000000000000)
            throw 0;
        return ms;
    }
    catch {
        throw new HttpError(400, 'Invalid nanosecond timestamp; send 64-bit values as strings');
    }
}
export function anyValue(v) {
    if (!v || typeof v !== 'object')
        return v;
    for (const k of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue'])
        if (k in v)
            return v[k];
    if (v.arrayValue)
        return array(v.arrayValue.values, 'values').map(anyValue);
    if (v.kvlistValue)
        return attributes(v.kvlistValue.values);
    return v;
}
function attributes(v) {
    return Object.fromEntries(array(v, 'attributes').map(a => [a.key, anyValue(a.value)]));
}
function text(v) {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
}
function severity(r) {
    if (r.severityText)
        return String(r.severityText).toUpperCase();
    const n = Number(r.severityNumber || 0);
    return n >= 21 ? 'FATAL' : n >= 17 ? 'ERROR' : n >= 13 ? 'WARN' : n >= 9 ? 'INFO' : n >= 5 ? 'DEBUG' : n >= 1 ? 'TRACE' : 'UNSPECIFIED';
}
export function normalize(batch) {
    const { payload, signal } = batch;
    const events = [];
    function push(e) {
        if (events.length >= MAX_EVENTS)
            throw new HttpError(413, `At most ${MAX_EVENTS} events per export; reduce exporter batch size`);
        events.push({ id: `${batch.id}:${events.length}`, batchId: batch.id, sourceId: batch.sourceId || 'legacy', index: events.length, seq: batch.seq ?? 0, receivedAt: batch.receivedAt, kind: signal === 'events' ? 'logs' : signal, timestamp: batch.receivedAt, service: 'unknown_service', severity: 'INFO', message: '', traceId: '', spanId: '', ...e });
    }
    if (signal === 'events') {
        const rows = Array.isArray(payload) ? payload : [object(payload, 'event')];
        for (const row of rows) {
            object(row, 'event');
            const stamp = row.timestamp === undefined ? batch.receivedAt : typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
            if (!Number.isFinite(stamp))
                throw new HttpError(400, 'Invalid event timestamp');
            push({ kind: ['logs', 'traces', 'metrics'].includes(row.kind) ? row.kind : 'logs', timestamp: stamp, service: String(row.service || 'unknown_service'), severity: String(row.severity || 'INFO').toUpperCase(), message: text(row.message ?? row.body ?? row), traceId: String(row.traceId || row.trace_id || '').toLowerCase(), spanId: String(row.spanId || row.span_id || '').toLowerCase(), metricName: row.metricName, value: row.value, raw: row });
        }
        return events;
    }
    object(payload, 'OTLP request');
    const top = { logs: 'resourceLogs', traces: 'resourceSpans', metrics: 'resourceMetrics' }[signal];
    if (!top)
        throw new HttpError(400, 'Unsupported signal');
    if (Object.keys(payload).length && !Object.hasOwn(payload, top))
        throw new HttpError(400, `Expected ${top}`);
    for (const group of array(payload[top], top)) {
        object(group, top);
        const resource = group.resource ?? {};
        const service = String(attributes(resource.attributes)['service.name'] || 'unknown_service');
        const scopeKey = { logs: 'scopeLogs', traces: 'scopeSpans', metrics: 'scopeMetrics' }[signal];
        for (const scope of array(group[scopeKey], scopeKey)) {
            object(scope, scopeKey);
            const common = { resource, scope: scope.scope ?? {}, resourceSchemaUrl: group.schemaUrl ?? '', scopeSchemaUrl: scope.schemaUrl ?? '' };
            if (signal === 'logs')
                for (const record of array(scope.logRecords, 'logRecords')) {
                    object(record, 'logRecord');
                    push({ service, timestamp: ns(record.timeUnixNano, ns(record.observedTimeUnixNano, batch.receivedAt)), severity: severity(record), message: text(anyValue(record.body)), traceId: String(record.traceId || '').toLowerCase(), spanId: String(record.spanId || '').toLowerCase(), raw: { ...common, record } });
                }
            if (signal === 'traces')
                for (const record of array(scope.spans, 'spans')) {
                    object(record, 'span');
                    let durationMs = 0;
                    if (record.startTimeUnixNano && record.endTimeUnixNano) {
                        ns(record.startTimeUnixNano, 0);
                        ns(record.endTimeUnixNano, 0);
                        durationMs = Number(BigInt(record.endTimeUnixNano) - BigInt(record.startTimeUnixNano)) / 1e6;
                    }
                    push({ service, timestamp: ns(record.startTimeUnixNano, batch.receivedAt), durationMs, severity: [2, 'STATUS_CODE_ERROR'].includes(record.status?.code) ? 'ERROR' : 'INFO', message: String(record.name || '(unnamed span)'), traceId: String(record.traceId || '').toLowerCase(), spanId: String(record.spanId || '').toLowerCase(), parentSpanId: String(record.parentSpanId || '').toLowerCase(), raw: { ...common, record } });
                }
            if (signal === 'metrics')
                for (const metric of array(scope.metrics, 'metrics')) {
                    object(metric, 'metric');
                    const type = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'].find(k => metric[k]);
                    if (!type)
                        continue;
                    for (const point of array(metric[type].dataPoints, 'dataPoints')) {
                        object(point, 'dataPoint');
                        const { dataPoints, ...aggregation } = metric[type];
                        const { gauge, sum, histogram, exponentialHistogram, summary, ...metadata } = metric;
                        const value = point.asDouble ?? point.asInt ?? point.sum ?? null;
                        push({ service, timestamp: ns(point.timeUnixNano, batch.receivedAt), metricName: String(metric.name || ''), metricType: type, unit: metric.unit || '', value, message: `${metric.name || '(unnamed metric)'} = ${value ?? '—'} ${metric.unit || ''}`.trim(), raw: { ...common, metric: metadata, aggregation: { type, ...aggregation }, point } });
                    }
                }
        }
    }
    return events;
}
/** Previews are bounded; stored policy-filtered fields remain available via /api/event. */
export function preview(event) {
    const { raw, ...rest } = event;
    const result = { ...rest };
    const truncated = [];
    for (const [key, max] of Object.entries({ message: 2048, service: 256, severity: 32, traceId: 64, spanId: 32, parentSpanId: 32, metricName: 256, unit: 64 })) {
        if (typeof result[key] === 'string' && result[key].length > max) {
            result[key] = result[key].slice(0, max);
            truncated.push(key);
        }
    }
    if (result.value !== null && result.value !== undefined && typeof result.value === 'object') {
        result.value = JSON.stringify(result.value).slice(0, 512);
        truncated.push('value');
    }
    if (typeof result.value === 'string' && result.value.length > 512) {
        result.value = result.value.slice(0, 512);
        truncated.push('value');
    }
    return { ...result, messageTruncated: event.message.length > 2048, previewTruncatedFields: truncated };
}
export async function decodeBody(request, signal) {
    const encoding = (request.headers.get('content-encoding') || 'identity').toLowerCase();
    if (!['identity', 'gzip'].includes(encoding))
        throw new HttpError(415, 'Only identity and gzip encodings are supported');
    let bytes = await bytesLimited(request.body, 512 * 1024);
    if (encoding === 'gzip') {
        try {
            bytes = await gunzip(bytes, 1024 * 1024);
        }
        catch (e) {
            if (e instanceof HttpError)
                throw e;
            throw new HttpError(400, 'Invalid gzip body');
        }
    }
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/x-protobuf')
        return { payload: decodeProtobuf(bytes, signal), wireBase64: toBase64(bytes), encoding: 'protobuf' };
    if (!['application/json', 'application/x-ndjson'].includes(type))
        throw new HttpError(415, 'Use application/json, application/x-protobuf, or /api/ingest application/x-ndjson');
    if (type === 'application/x-ndjson' && signal !== 'events')
        throw new HttpError(415, 'NDJSON is supported only at /api/ingest');
    let payload;
    try {
        const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        payload = type === 'application/x-ndjson' ? s.split('\n').filter(x => x.trim()).map(x => JSON.parse(x)) : JSON.parse(s);
    }
    catch {
        throw new HttpError(400, 'Invalid JSON body');
    }
    return { payload, encoding: 'json' };
}
