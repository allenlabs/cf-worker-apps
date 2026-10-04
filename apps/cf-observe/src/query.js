import { normalize, preview } from './protocol.js';
import { readManifest, readSegment } from './segments.js';
import { sign, verify } from './auth.js';
import { HttpError, hourStart, datasetName, configuredInt } from './util.js';
export function journalStub(env) {
    return env.JOURNAL.get(env.JOURNAL.idFromName(datasetName(env)));
}
async function callJournal(env, path) {
    const res = await journalStub(env).fetch(new Request(`https://journal${path}`));
    if (!res.ok)
        throw new HttpError(502, 'Temporary journal is unavailable');
    return res.json();
}
export function parseFilters(input) {
    const from = Number(input.from), to = Number(input.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > 8640000000000000)
        throw new HttpError(400, 'from/to must be valid epoch milliseconds, with from <= to');
    const f = { from, to, kind: String(input.kind || ''), service: String(input.service || ''), q: String(input.q || ''), traceId: String(input.traceId || '').toLowerCase() };
    if (f.kind && !['logs', 'traces', 'metrics'].includes(f.kind))
        throw new HttpError(400, 'Unknown signal filter');
    if (f.q.length > 512 || f.service.length > 256 || f.traceId.length > 64)
        throw new HttpError(400, 'Query filter is too long');
    return f;
}
export function matches(e, f) {
    return e.receivedAt >= f.from && e.receivedAt <= f.to && (!f.kind || e.kind === f.kind) && (!f.service || e.service === f.service) && (!f.traceId || e.traceId === f.traceId) && (!f.q || JSON.stringify(e.raw).toLowerCase().includes(f.q.toLowerCase()) || e.message.toLowerCase().includes(f.q.toLowerCase()));
}
async function locateBatch(env, locator, stats) {
    const response = await journalStub(env).fetch(new Request(`https://journal/batch?seq=${locator.seq}`));
    if (response.ok)
        return { batch: await response.json(), storage: 'buffer' };
    if (response.status !== 404)
        throw new HttpError(502, 'Temporary journal is unavailable');
    // The batch can move after /snapshot and after the first manifest read. Refresh here.
    const manifest = await readManifest(env, hourStart(locator.receivedAt));
    if (stats)
        stats.manifests++;
    const segment = manifest.segments.find(s => s.firstSeq <= locator.seq && s.lastSeq >= locator.seq);
    if (!segment)
        throw new HttpError(502, 'Batch is not present in either storage layer; retry and inspect health');
    const batches = await readSegment(env, segment.key);
    if (stats) {
        stats.segments++;
        stats.compressedBytes += segment.bytes;
        stats.plainBytes += segment.plainBytes;
    }
    const batch = batches.find(b => b.seq === locator.seq);
    if (!batch)
        throw new HttpError(502, 'Archive index and payload disagree');
    return { batch, storage: 'r2' };
}
export async function queryEvents(env, input) {
    const filters = parseFilters(input);
    const limit = input.limit === undefined ? 200 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new HttpError(400, 'limit must be between 1 and 500');
    let cursor;
    if (input.cursor) {
        try {
            cursor = await verify(env, input.cursor, 'cursor');
            if (JSON.stringify(cursor.filters) !== JSON.stringify(filters))
                throw 0;
        }
        catch {
            throw new HttpError(400, 'Invalid, expired, or mismatched cursor');
        }
    }
    // Snapshot FIRST, then manifests: an archive commit cannot create an invisible gap.
    const snapshot = await callJournal(env, `/snapshot?from=${filters.from}&to=${filters.to}`);
    const watermark = cursor?.watermark ?? snapshot.watermark;
    let hour = cursor?.hour ?? hourStart(filters.to);
    let beforeSeq = cursor?.beforeSeq ?? watermark + 1, beforeIndex = cursor?.beforeIndex ?? 2147483647;
    const stats = { manifests: 0, segments: 0, compressedBytes: 0, plainBytes: 0, eventsExamined: 0, pendingBatchesRead: 0 };
    const events = [], seen = new Set();
    let stopped = false;
    const maxSegments = configuredInt(env.MAX_QUERY_SEGMENTS, 12, 1, 64), maxHours = 24, maxPlain = 32 * 1024 * 1024;
    const advance = (seq, index) => {
        beforeSeq = seq;
        beforeIndex = index;
    };
    const metaMatches = s => (s.maxReceivedAt >= filters.from && s.minReceivedAt <= filters.to) && (!filters.service || !s.services || s.services.includes(filters.service)) && (!filters.kind || s.kinds.includes(filters.kind));
    while (hour >= hourStart(filters.from)) {
        if (stats.manifests >= maxHours) {
            stopped = true;
            break;
        }
        const manifest = await readManifest(env, hour);
        stats.manifests++;
        const archived = manifest.segments.filter(s => s.firstSeq <= watermark && s.firstSeq <= beforeSeq);
        const pending = snapshot.batches.filter(b => b.seq <= watermark && b.seq <= beforeSeq && hourStart(b.received_at) === hour && !archived.some(s => s.firstSeq <= b.seq && s.lastSeq >= b.seq));
        const sources = [...archived.map(meta => ({ type: 'r2', meta, top: meta.lastSeq, bottom: meta.firstSeq })), ...pending.map(meta => ({ type: 'buffer', meta, top: meta.seq, bottom: meta.seq }))].sort((a, b) => b.top - a.top);
        for (const source of sources) {
            if (source.bottom > beforeSeq)
                continue;
            if (source.bottom === beforeSeq && beforeIndex < 0)
                continue;
            if (source.type === 'r2' && !metaMatches(source.meta)) {
                advance(source.bottom, -1);
                continue;
            }
            if (stats.segments + stats.pendingBatchesRead >= maxSegments || stats.plainBytes >= maxPlain) {
                stopped = true;
                break;
            }
            let batches, storage = source.type;
            if (storage === 'r2') {
                if (stats.plainBytes + source.meta.plainBytes > maxPlain && stats.segments > 0) {
                    stopped = true;
                    break;
                }
                batches = await readSegment(env, source.meta.key);
                stats.segments++;
                stats.compressedBytes += source.meta.bytes;
                stats.plainBytes += source.meta.plainBytes;
            }
            else {
                const resolved = await locateBatch(env, { seq: source.meta.seq, receivedAt: source.meta.received_at }, stats);
                batches = [resolved.batch];
                storage = resolved.storage;
                stats.pendingBatchesRead++;
            }
            batches.sort((a, b) => b.seq - a.seq);
            for (const batch of batches) {
                if (batch.seq > watermark || batch.seq > beforeSeq || (batch.seq === beforeSeq && beforeIndex < 0))
                    continue;
                const normalized = normalize(batch);
                for (let i = normalized.length - 1; i >= 0; i--) {
                    if (batch.seq === beforeSeq && i >= beforeIndex)
                        continue;
                    const event = normalized[i];
                    stats.eventsExamined++;
                    advance(batch.seq, i);
                    if (matches(event, filters) && !seen.has(event.id)) {
                        seen.add(event.id);
                        events.push({ ...preview(event), storage });
                    }
                    if (events.length >= limit) {
                        stopped = true;
                        break;
                    }
                }
                if (stopped)
                    break;
                advance(batch.seq, -1);
            }
            if (stopped)
                break;
            advance(source.bottom, -1);
        }
        if (stopped)
            break;
        hour -= 3600000;
        beforeSeq = watermark + 1;
        beforeIndex = 2147483647;
    }
    const complete = !stopped && hour < hourStart(filters.from);
    const nextCursor = complete ? null : await sign(env, { purpose: 'cursor', exp: Date.now() + 3600000, filters, watermark, hour, beforeSeq, beforeIndex });
    return { events, nextCursor, complete, watermark, scanned: stats, timeBasis: 'receivedAt', note: complete ? 'Requested range fully examined.' : 'Partial page. Continue with nextCursor; counts describe loaded results only.' };
}
export async function getEvent(env, input) {
    const seq = Number(input.seq), receivedAt = Number(input.receivedAt), id = String(input.id || '');
    if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || !/^[a-zA-Z0-9_-]{1,80}:\d{1,4}$/.test(id))
        throw new HttpError(400, 'Invalid event locator');
    const { batch, storage } = await locateBatch(env, { seq, receivedAt });
    const event = normalize(batch).find(e => e.id === id);
    if (!event)
        throw new HttpError(404, 'Event not found');
    return { event, storage, batch };
}
