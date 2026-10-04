/* OTLP wire field mappings derived from open-telemetry/opentelemetry-proto,
 * Apache-2.0. See THIRD_PARTY_NOTICES.md. Unknown fields are skipped in the view;
 * protocol.js exposes wire bytes while decoding; the ingestion policy omits
 * them before persistence because unknown fields cannot be safely filtered.
 */
import { HttpError, toBase64 } from './util.js';
const f = (name, type, repeated = false) => ({ name, type, repeated });
const S = {
    Any: { 1: f('stringValue', 'string'), 2: f('boolValue', 'bool'), 3: f('intValue', 'int64'), 4: f('doubleValue', 'double'), 5: f('arrayValue', 'Array'), 6: f('kvlistValue', 'KVList'), 7: f('bytesValue', 'bytes') },
    Array: { 1: f('values', 'Any', true) }, KVList: { 1: f('values', 'KV', true) }, KV: { 1: f('key', 'string'), 2: f('value', 'Any') },
    Resource: { 1: f('attributes', 'KV', true), 2: f('droppedAttributesCount', 'uint') },
    Scope: { 1: f('name', 'string'), 2: f('version', 'string'), 3: f('attributes', 'KV', true), 4: f('droppedAttributesCount', 'uint') },
    logs: { 1: f('resourceLogs', 'ResourceLogs', true) },
    ResourceLogs: { 1: f('resource', 'Resource'), 2: f('scopeLogs', 'ScopeLogs', true), 3: f('schemaUrl', 'string') },
    ScopeLogs: { 1: f('scope', 'Scope'), 2: f('logRecords', 'Log', true), 3: f('schemaUrl', 'string') },
    Log: { 1: f('timeUnixNano', 'fixed64'), 2: f('severityNumber', 'uint'), 3: f('severityText', 'string'), 5: f('body', 'Any'), 6: f('attributes', 'KV', true), 7: f('droppedAttributesCount', 'uint'), 8: f('flags', 'fixed32'), 9: f('traceId', 'hex'), 10: f('spanId', 'hex'), 11: f('observedTimeUnixNano', 'fixed64'), 12: f('eventName', 'string') },
    traces: { 1: f('resourceSpans', 'ResourceSpans', true) },
    ResourceSpans: { 1: f('resource', 'Resource'), 2: f('scopeSpans', 'ScopeSpans', true), 3: f('schemaUrl', 'string') },
    ScopeSpans: { 1: f('scope', 'Scope'), 2: f('spans', 'Span', true), 3: f('schemaUrl', 'string') },
    Span: { 1: f('traceId', 'hex'), 2: f('spanId', 'hex'), 3: f('traceState', 'string'), 4: f('parentSpanId', 'hex'), 5: f('name', 'string'), 6: f('kind', 'uint'), 7: f('startTimeUnixNano', 'fixed64'), 8: f('endTimeUnixNano', 'fixed64'), 9: f('attributes', 'KV', true), 10: f('droppedAttributesCount', 'uint'), 11: f('events', 'SpanEvent', true), 12: f('droppedEventsCount', 'uint'), 13: f('links', 'Link', true), 14: f('droppedLinksCount', 'uint'), 15: f('status', 'Status'), 16: f('flags', 'fixed32') },
    SpanEvent: { 1: f('timeUnixNano', 'fixed64'), 2: f('name', 'string'), 3: f('attributes', 'KV', true), 4: f('droppedAttributesCount', 'uint') },
    Link: { 1: f('traceId', 'hex'), 2: f('spanId', 'hex'), 3: f('traceState', 'string'), 4: f('attributes', 'KV', true), 5: f('droppedAttributesCount', 'uint'), 6: f('flags', 'fixed32') }, Status: { 2: f('message', 'string'), 3: f('code', 'uint') },
    metrics: { 1: f('resourceMetrics', 'ResourceMetrics', true) },
    ResourceMetrics: { 1: f('resource', 'Resource'), 2: f('scopeMetrics', 'ScopeMetrics', true), 3: f('schemaUrl', 'string') },
    ScopeMetrics: { 1: f('scope', 'Scope'), 2: f('metrics', 'Metric', true), 3: f('schemaUrl', 'string') },
    Metric: { 1: f('name', 'string'), 2: f('description', 'string'), 3: f('unit', 'string'), 5: f('gauge', 'Gauge'), 7: f('sum', 'Sum'), 9: f('histogram', 'Histogram'), 10: f('exponentialHistogram', 'ExponentialHistogram'), 11: f('summary', 'Summary'), 12: f('metadata', 'KV', true) },
    Gauge: { 1: f('dataPoints', 'NumberPoint', true) }, Sum: { 1: f('dataPoints', 'NumberPoint', true), 2: f('aggregationTemporality', 'uint'), 3: f('isMonotonic', 'bool') },
    Histogram: { 1: f('dataPoints', 'HistogramPoint', true), 2: f('aggregationTemporality', 'uint') }, ExponentialHistogram: { 1: f('dataPoints', 'ExponentialPoint', true), 2: f('aggregationTemporality', 'uint') }, Summary: { 1: f('dataPoints', 'SummaryPoint', true) },
    NumberPoint: { 7: f('attributes', 'KV', true), 2: f('startTimeUnixNano', 'fixed64'), 3: f('timeUnixNano', 'fixed64'), 4: f('asDouble', 'double'), 5: f('exemplars', 'Exemplar', true), 6: f('asInt', 'sfixed64'), 8: f('flags', 'uint') },
    HistogramPoint: { 9: f('attributes', 'KV', true), 2: f('startTimeUnixNano', 'fixed64'), 3: f('timeUnixNano', 'fixed64'), 4: f('count', 'fixed64'), 5: f('sum', 'double'), 6: f('bucketCounts', 'fixed64', true), 7: f('explicitBounds', 'double', true), 8: f('exemplars', 'Exemplar', true), 10: f('flags', 'uint'), 11: f('min', 'double'), 12: f('max', 'double') },
    ExponentialPoint: { 1: f('attributes', 'KV', true), 2: f('startTimeUnixNano', 'fixed64'), 3: f('timeUnixNano', 'fixed64'), 4: f('count', 'fixed64'), 5: f('sum', 'double'), 6: f('scale', 'sint'), 7: f('zeroCount', 'fixed64'), 8: f('positive', 'Buckets'), 9: f('negative', 'Buckets'), 10: f('flags', 'uint'), 11: f('exemplars', 'Exemplar', true), 12: f('min', 'double'), 13: f('max', 'double'), 14: f('zeroThreshold', 'double') },
    Buckets: { 1: f('offset', 'sint'), 2: f('bucketCounts', 'uint64', true) },
    SummaryPoint: { 7: f('attributes', 'KV', true), 2: f('startTimeUnixNano', 'fixed64'), 3: f('timeUnixNano', 'fixed64'), 4: f('count', 'fixed64'), 5: f('sum', 'double'), 6: f('quantileValues', 'Quantile', true), 8: f('flags', 'uint') }, Quantile: { 1: f('quantile', 'double'), 2: f('value', 'double') },
    Exemplar: { 7: f('filteredAttributes', 'KV', true), 2: f('timeUnixNano', 'fixed64'), 3: f('asDouble', 'double'), 4: f('spanId', 'hex'), 5: f('traceId', 'hex'), 6: f('asInt', 'sfixed64') }
};
class Reader {
    constructor(bytes, budget = { fields: 0 }) {
        this.bytes = bytes;
        this.pos = 0;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.budget = budget;
    }
    need(n) {
        if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length)
            throw new HttpError(400, 'Truncated protobuf');
    }
    varint() {
        let v = 0n;
        for (let n = 0; n < 10; n++) {
            this.need(1);
            const b = this.bytes[this.pos++];
            if (n === 9 && b > 1)
                throw new HttpError(400, 'Invalid protobuf varint');
            v |= BigInt(b & 127) << BigInt(n * 7);
            if (!(b & 128))
                return v;
        }
        throw new HttpError(400, 'Invalid protobuf varint');
    }
    slice() {
        const n = Number(this.varint());
        this.need(n);
        const b = this.bytes.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }
    skip(wire) {
        if (wire === 0)
            this.varint();
        else if (wire === 1) {
            this.need(8);
            this.pos += 8;
        }
        else if (wire === 2)
            this.slice();
        else if (wire === 5) {
            this.need(4);
            this.pos += 4;
        }
        else
            throw new HttpError(400, 'Unsupported protobuf wire type');
    }
    scalar(type, wire, depth) {
        if (S[type]) {
            if (wire !== 2)
                throw new HttpError(400, 'Wrong protobuf wire type');
            return new Reader(this.slice(), this.budget).message(type, depth + 1);
        }
        if (['string', 'hex', 'bytes'].includes(type)) {
            if (wire !== 2)
                throw new HttpError(400, 'Wrong protobuf wire type');
            const b = this.slice();
            return type === 'string' ? new TextDecoder('utf-8', { fatal: true }).decode(b) : type === 'bytes' ? toBase64(b) : [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        }
        if (['fixed64', 'sfixed64', 'double'].includes(type)) {
            if (wire !== 1)
                throw new HttpError(400, 'Wrong protobuf wire type');
            this.need(8);
            let v = type === 'double' ? this.view.getFloat64(this.pos, true) : type === 'sfixed64' ? this.view.getBigInt64(this.pos, true) : this.view.getBigUint64(this.pos, true);
            this.pos += 8;
            return typeof v === 'bigint' ? v.toString() : Number.isFinite(v) ? v : String(v);
        }
        if (type === 'fixed32') {
            if (wire !== 5)
                throw new HttpError(400, 'Wrong protobuf wire type');
            this.need(4);
            const v = this.view.getUint32(this.pos, true);
            this.pos += 4;
            return v;
        }
        if (wire !== 0)
            throw new HttpError(400, 'Wrong protobuf wire type');
        const v = this.varint();
        if (type === 'uint64')
            return v.toString();
        if (type === 'int64')
            return BigInt.asIntN(64, v).toString();
        if (type === 'bool')
            return v !== 0n;
        if (type === 'sint')
            return Number((v >> 1n) ^ -(v & 1n));
        if (v > 0xffffffffn)
            throw new HttpError(400, 'uint32 overflow');
        return Number(v);
    }
    message(type, depth = 0) {
        if (depth > 32)
            throw new HttpError(400, 'Protobuf nesting too deep');
        const out = {};
        while (this.pos < this.bytes.length) {
            if (++this.budget.fields > 100000)
                throw new HttpError(413, 'Too many protobuf fields');
            const tag = Number(this.varint()), number = Math.floor(tag / 8), wire = tag & 7;
            if (!number)
                throw new HttpError(400, 'Invalid protobuf field');
            const field = S[type][number];
            if (!field) {
                this.skip(wire);
                continue;
            }
            let values;
            if (field.repeated && wire === 2 && !S[field.type] && !['string', 'hex', 'bytes'].includes(field.type)) {
                const r = new Reader(this.slice(), this.budget);
                values = [];
                const w = ['fixed64', 'sfixed64', 'double'].includes(field.type) ? 1 : field.type === 'fixed32' ? 5 : 0;
                while (r.pos < r.bytes.length) {
                    if (++this.budget.fields > 100000)
                        throw new HttpError(413, 'Too many packed values');
                    values.push(r.scalar(field.type, w, depth));
                }
            }
            else
                values = [this.scalar(field.type, wire, depth)];
            if (field.repeated) {
                out[field.name] ??= [];
                out[field.name].push(...values);
            }
            else
                out[field.name] = values[0];
        }
        return out;
    }
}
export function decodeProtobuf(bytes, signal) {
    if (!S[signal])
        throw new HttpError(415, 'Protobuf is supported only for OTLP logs, traces and metrics');
    try {
        return new Reader(bytes).message(signal);
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(400, 'Invalid protobuf payload');
    }
}
