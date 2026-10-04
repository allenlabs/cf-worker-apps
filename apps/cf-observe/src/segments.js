import { normalize } from './protocol.js';
import { gzip, gunzip, utf8, hourPath, hourStart, datasetName, sha256, HttpError } from './util.js';
export const indexKey = (env, hour) => `index/${datasetName(env)}/${hourPath(hour)}.json`;
export async function readManifest(env, hour) {
    const obj = await env.ARCHIVE.get(indexKey(env, hour));
    if (!obj)
        return { version: 1, hour, segments: [] };
    if (obj.size > 16 * 1024 * 1024)
        throw new HttpError(502, 'Archive manifest exceeds the 16 MiB safety budget');
    const value = await obj.json();
    if (value.version !== 1 || !Array.isArray(value.segments) || value.segments.length > 12000)
        throw new HttpError(502, 'Invalid archive manifest');
    return value;
}
export async function readSegment(env, key, maxBytes = 8 * 1024 * 1024) {
    if (!key.startsWith(`segments/${datasetName(env)}/`) || !key.endsWith('.ndjson.gz'))
        throw new HttpError(400, 'Invalid segment reference');
    const obj = await env.ARCHIVE.get(key);
    if (!obj)
        throw new HttpError(502, 'Archive segment is missing; do not delete raw objects without rebuilding manifests');
    if (obj.size > maxBytes)
        throw new HttpError(502, 'Segment exceeds read budget');
    const data = await gunzip(new Uint8Array(await obj.arrayBuffer()), maxBytes);
    return new TextDecoder().decode(data).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function persistJob(env, job, batches) {
    const plain = utf8.encode(batches.map(b => JSON.stringify(b)).join('\n') + '\n');
    const compressed = await gzip(plain);
    const services = new Set(), kinds = new Set();
    let count = 0, errorCount = 0;
    for (const batch of batches)
        for (const event of normalize(batch)) {
            count++;
            if (['ERROR', 'FATAL'].includes(event.severity))
                errorCount++;
            services.add(event.service);
            kinds.add(event.kind);
        }
    const entry = { key: job.key, hour: job.hour, firstSeq: job.firstSeq, lastSeq: job.lastSeq, minReceivedAt: Math.min(...batches.map(b => b.receivedAt)), maxReceivedAt: Math.max(...batches.map(b => b.receivedAt)), count, errorCount, services: services.size <= 128 && JSON.stringify([...services]).length <= 512 ? [...services] : null, kinds: [...kinds], bytes: compressed.length, plainBytes: plain.length, sha256: await sha256(compressed) };
    // Write the data first. A stable persisted job key makes ambiguous PUT retries safe.
    await env.ARCHIVE.put(job.key, compressed, { httpMetadata: { contentType: 'application/gzip', cacheControl: 'private, no-store' }, customMetadata: { format: 'cf-observe-v1' } });
    const manifest = await readManifest(env, job.hour);
    manifest.segments = manifest.segments.filter(s => s.key !== entry.key);
    manifest.segments.push(entry);
    manifest.segments.sort((a, b) => a.firstSeq - b.firstSeq);
    const serializedManifest = JSON.stringify(manifest);
    if (utf8.encode(serializedManifest).length > 16 * 1024 * 1024 || manifest.segments.length > 12000)
        throw new HttpError(503, 'Archive index capacity exceeded; inspect backlog and deployment throughput');
    await env.ARCHIVE.put(indexKey(env, job.hour), serializedManifest, { httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } });
    return entry;
}
export function newJob(env, rows) {
    const firstSeq = rows[0].seq, lastSeq = rows.at(-1).seq, hour = hourStart(rows[0].received_at);
    return { firstSeq, lastSeq, hour, key: `segments/${datasetName(env)}/${hourPath(hour)}/${String(firstSeq).padStart(12, '0')}-${String(lastSeq).padStart(12, '0')}-${crypto.randomUUID()}.ndjson.gz` };
}
