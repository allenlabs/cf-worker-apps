import { TelemetryJournal } from './journal.js';
import { authorizeIngest, authorizeViewer, login, logout, requireSameOrigin } from './auth.js';
import { decodeBody, normalize } from './protocol.js';
import { queryEvents, getEvent, journalStub, parseFilters } from './query.js';
import { HttpError, json, errorResponse, utf8, base64url, sha256 } from './util.js';
import { applyIngestPolicy } from './ingest-policy.js';
import { otlpError, otlpPaths } from './otlp-response.js';
import { inspectArchive } from './archive-integrity.js';
export { TelemetryJournal };
function headers(response) {
    if (response.status === 101)
        return response;
    const h = new Headers(response.headers);
    h.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss: ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    h.set('x-content-type-options', 'nosniff');
    h.set('referrer-policy', 'no-referrer');
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
async function route(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/healthz')
        return json({ service: 'cf-observe', version: '0.1.0' });
    if (path === '/api/session' && request.method === 'POST')
        return login(request, env);
    if (path === '/api/session' && request.method === 'DELETE')
        return logout(request);
    const signal = { '/v1/logs': 'logs', '/v1/traces': 'traces', '/v1/metrics': 'metrics', '/api/ingest': 'events' }[path];
    if (signal) {
        if (request.method !== 'POST')
            throw new HttpError(405, 'POST required');
        const identity = await authorizeIngest(request, env);
        const idempotencyKey = request.headers.get('idempotency-key') || '';
        if (idempotencyKey.length > 256)
            throw new HttpError(400, 'Idempotency-Key must not exceed 256 characters');
        const decoded = await decodeBody(request, signal);
        // Migration-only fingerprint for receipts written before filtering/source identities.
        // Keep it outside the persisted batch and never store the unfiltered request.
        const legacyDigest = idempotencyKey && identity.sourceId === 'legacy'
            ? await sha256(JSON.stringify({ signal, payload: decoded.payload, wireBase64: decoded.wireBase64 })) : undefined;
        const batch = { id: crypto.randomUUID(), receivedAt: Date.now(), signal, sourceId: identity.sourceId, ...applyIngestPolicy(decoded) };
        normalize(batch);
        let receipt;
        try {
            const response = await journalStub(env).fetch(new Request('https://journal/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batch, idempotencyKey, legacyDigest }) }));
            if (!response.ok) {
                const error = await response.json();
                throw new HttpError(response.status === 500 ? 503 : response.status, response.status === 500 ? 'Durable ingestion is temporarily unavailable; retry with backoff' : error.error || 'Ingestion failed');
            }
            receipt = await response.json();
        }
        catch (error) {
            if (error instanceof HttpError)
                throw error;
            throw new HttpError(503, 'Durable ingestion is temporarily unavailable; retry with backoff');
        }
        if (signal === 'events')
            return json(receipt, 202);
        const common = { 'x-cf-observe-batch-id': receipt.batchId, 'x-cf-observe-durability': receipt.durability, 'cache-control': 'no-store' };
        if (decoded.encoding === 'protobuf')
            return new Response(new Uint8Array(), { status: 200, headers: { ...common, 'content-type': 'application/x-protobuf' } });
        return json({}, 200, common);
    }
    if (path.startsWith('/api/')) {
        const session = await authorizeViewer(request, env);
        requireSameOrigin(request);
        if (request.method !== 'GET')
            throw new HttpError(405, 'GET required');
        if (path === '/api/health') {
            const r = await journalStub(env).fetch(new Request('https://journal/health'));
            if (!r.ok)
                return r;
            return json({ ...await r.json(), demo: env.LOCAL_DEMO === 'true', version: '0.1.0' });
        }
        if (path === '/api/events')
            return json(await queryEvents(env, Object.fromEntries(url.searchParams)));
        if (path === '/api/archive/check')
            return json(await inspectArchive(env, Object.fromEntries(url.searchParams)));
        if (path === '/api/event')
            return json(await getEvent(env, Object.fromEntries(url.searchParams)));
        if (path === '/api/live') {
            requireSameOrigin(request, true);
            if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
                throw new HttpError(426, 'WebSocket upgrade required');
            const filters = parseFilters({ ...Object.fromEntries(url.searchParams), from: 0, to: 8640000000000000 });
            return journalStub(env).fetch(new Request('https://journal/subscribe', { headers: { upgrade: 'websocket', 'x-session-exp': String(session.exp), 'x-live-filters': base64url(utf8.encode(JSON.stringify(filters))) } }));
        }
        throw new HttpError(404, 'Unknown API route');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new HttpError(405, 'GET required');
    return env.ASSETS.fetch(request);
}
export default {
    async fetch(request, env) {
        try {
            return headers(await route(request, env));
        }
        catch (e) {
            return headers(otlpPaths.has(new URL(request.url).pathname) ? otlpError(request, e) : errorResponse(e));
        }
    },
    async scheduled(_event, env, ctx) {
        // Recovery guard only; it does not scan R2 or create idle archive files.
        const work = journalStub(env).fetch(new Request('https://journal/kick')).then(r => {
            if (!r.ok)
                throw new Error('Journal recovery failed');
        });
        if (ctx?.waitUntil)
            ctx.waitUntil(work);
        else
            await work;
    }
};
