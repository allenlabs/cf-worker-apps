/** Explicitly writes ONE synthetic event to the specified deployment. */
import assert from 'node:assert/strict';
const origin = process.env.OBSERVE_URL, ingest = process.env.INGEST_TOKEN, viewer = process.env.VIEWER_TOKEN;
if (!origin || !ingest || !viewer) {
    console.error('Set OBSERVE_URL, INGEST_TOKEN and VIEWER_TOKEN. This script writes a synthetic smoke-test event.');
    process.exit(1);
}
const url = new URL(origin);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Remote deployments require HTTPS');
const marker = `cf-observe-smoke-${crypto.randomUUID()}`, from = Date.now() - 5000, to = Date.now() + 30000;
async function request(path, token, options = {}) {
    return fetch(new URL(path, url), { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(15000) });
}
try {
    assert.equal((await fetch(new URL('/api/health', url))).status, 401);
    assert.equal((await request('/api/ingest', viewer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })).status, 401);
    const body = JSON.stringify([{ service: 'cf-observe-smoke', severity: 'INFO', message: marker, attributes: { synthetic: true } }]);
    const start = Date.now();
    const response = await request('/api/ingest', ingest, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': marker }, body });
    assert.equal(response.status, 202, await response.clone().text());
    const receipt = await response.json();
    const repeated = await request('/api/ingest', ingest, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': marker }, body });
    assert.equal((await repeated.json()).batchId, receipt.batchId);
    const params = new URLSearchParams({ from: String(from), to: String(to), q: marker, service: 'cf-observe-smoke', limit: '10' });
    const pageResponse = await request('/api/events?' + params, viewer);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.events.length, 1);
    const event = page.events[0];
    const detail = await (await request('/api/event?' + new URLSearchParams({ id: event.id, seq: String(event.seq), receivedAt: String(event.receivedAt) }), viewer)).json();
    assert.equal(detail.event.raw.message, marker);
    console.log(`PASS: ingestion, idempotency, auth separation, immediate query and raw inspection (${Date.now() - start}ms on this run; not an SLA).`);
    const deadline = Date.now() + 90000;
    let archived = false;
    while (Date.now() < deadline) {
        const health = await (await request('/api/health', viewer)).json();
        if (health.lastArchivedSeq >= receipt.seq) {
            archived = true;
            break;
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    assert.ok(archived, 'Not archived within smoke-test deadline; inspect /api/health');
    const after = await (await request('/api/events?' + params, viewer)).json();
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].storage, 'r2');
    console.log('PASS: same event is readable from the R2 archive. Synthetic record is retained by design.');
}
catch (e) {
    console.error('FAIL:', e.message);
    process.exitCode = 1;
}
