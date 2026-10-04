import { HttpError, json, utf8 } from './util.js';

export const otlpPaths = new Set(['/v1/logs', '/v1/traces', '/v1/metrics']);
function varint(value) {
    const bytes = [];
    do {
        const byte = value & 127;
        value >>>= 7;
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return bytes;
}
/** google.rpc.Status.message (field 2); OTLP does not require Status.code. */
export function otlpError(request, error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal error. No payload is logged.';
    const headers = [429, 502, 503, 504].includes(status) ? { 'retry-after': '10' } : {};
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/x-protobuf') {
        const value = utf8.encode(message);
        return new Response(new Uint8Array([18, ...varint(value.length), ...value]), { status, headers: { 'content-type': type, 'cache-control': 'no-store', ...headers } });
    }
    return json({ message }, status, headers);
}
