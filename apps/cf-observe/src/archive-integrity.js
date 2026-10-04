import { datasetName, hourPath, hourStart, HttpError } from './util.js';
import { indexKey } from './segments.js';

// Explicit, read-only inspection. Never called by normal live/query polling.
// One hour, one LIST (at most 1000 keys), one manifest GET; no raw-body reads.
export async function inspectArchive(env, params = {}) {
    const now = Date.now();
    const input = params.hour === undefined ? hourStart(now) - 3600000 : Number(params.hour);
    if (params.hour === '' || !Number.isSafeInteger(input) || input < 0 || input > now)
        throw new HttpError(400, 'hour must be a non-future Unix timestamp in milliseconds');
    const hour = hourStart(input), prefix = `segments/${datasetName(env)}/${hourPath(hour)}/`;
    const [object, listing] = await Promise.all([
        env.ARCHIVE.get(indexKey(env, hour)), env.ARCHIVE.list({ prefix, limit: 1000 }),
    ]);
    const invalid = [], entries = [];
    if (object) {
        if (object.size > 16 * 1024 * 1024) invalid.push('Manifest exceeds the 16 MiB inspection budget');
        else {
            let manifest, parsed = false;
            try { manifest = await object.json(); parsed = true; }
            catch { invalid.push('Manifest is not valid JSON'); }
            if (parsed) {
                if (!manifest || manifest.version !== 1 || manifest.hour !== hour || !Array.isArray(manifest.segments) || manifest.segments.length > 12000)
                    invalid.push('Manifest schema, hour or segment count is invalid');
                else entries.push(...manifest.segments);
            }
        }
    }
    const referenced = new Set(), ranges = [];
    for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(prefix) || !entry.key.endsWith('.ndjson.gz')) {
            invalid.push('Segment reference is outside the selected hour or format');
            continue;
        }
        if (referenced.has(entry.key)) invalid.push('Duplicate segment reference');
        referenced.add(entry.key);
        if (!Number.isSafeInteger(entry.firstSeq) || !Number.isSafeInteger(entry.lastSeq) || entry.firstSeq < 1 || entry.lastSeq < entry.firstSeq)
            invalid.push('Invalid sequence range');
        else ranges.push([entry.firstSeq, entry.lastSeq]);
    }
    ranges.sort((a,b) => a[0] - b[0]);
    let highest = 0;
    for (const [first,last] of ranges) {
        if (first <= highest) invalid.push('Overlapping sequence ranges');
        highest = Math.max(highest,last);
    }
    const listed = new Set(listing.objects.map(o => o.key));
    const missing = listing.truncated ? [] : [...referenced].filter(k => !listed.has(k));
    const unindexed = [...listed].filter(k => !referenced.has(k));
    const anomalies = invalid.length + missing.length + unindexed.length;
    const activeHour = hour === hourStart(now);
    return {
        hour, checkedAt: now, activeHour, manifestPresent: Boolean(object),
        status: listing.truncated ? 'incomplete' : anomalies ? 'warning' : object ? 'healthy' : 'empty',
        complete: !listing.truncated, listedSegments: listed.size, referencedSegments: referenced.size,
        missing: missing.slice(0,100), missingCount: missing.length,
        unindexed: unindexed.slice(0,100), unindexedCount: unindexed.length,
        invalid: [...new Set(invalid)].slice(0,100),
        inspectedBodies: false, automaticRetention: false,
        advice: 'This is a read-only index/key comparison, not a payload checksum or deletion plan. '
            + (activeHour ? 'Active-hour publication may be in progress; recheck after the pending journal has drained.'
                : 'Unindexed objects can belong to an interrupted publication; inspect pending jobs before any repair. '
                    + 'An empty result cannot detect loss of both the index and all raw objects.'),
    };
}
