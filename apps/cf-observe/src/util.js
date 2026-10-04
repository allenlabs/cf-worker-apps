export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export const utf8 = new TextEncoder();
export function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
export async function bytesLimited(stream, limit) {
    if (!stream)
        return new Uint8Array();
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            length += value.byteLength;
            if (length > limit) {
                await reader.cancel();
                throw new HttpError(413, `Body exceeds ${limit} bytes`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}
export function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192)
        s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
}
export function fromBase64(s) {
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
export function base64url(bytes) {
    return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unbase64url(s) {
    return fromBase64(s.replaceAll('-', '+').replaceAll('_', '/'));
}
export async function sha256(data) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8.encode(data) : data))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function gzip(data) {
    return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
export async function gunzip(data, limit = 8 * 1024 * 1024) {
    return bytesLimited(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')), limit);
}
export function hourStart(ms) {
    return Math.floor(ms / 3600000) * 3600000;
}
export function hourPath(ms) {
    return new Date(hourStart(ms)).toISOString().slice(0, 13).replaceAll('-', '/').replace('T', '/');
}
export function datasetName(env) {
    const s = env.DATASET || 'default';
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(s))
        throw new HttpError(503, 'Invalid DATASET configuration');
    return s;
}
export function configuredInt(value, fallback, min, max) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < min || n > max)
        throw new HttpError(503, 'Invalid numeric configuration');
    return n;
}
export function errorResponse(e) {
    return json({ error: e instanceof HttpError ? e.message : 'Internal error. Check health and retry; no payload is logged.' }, e instanceof HttpError ? e.status : 500, e.status === 503 ? { 'retry-after': '10' } : {});
}
