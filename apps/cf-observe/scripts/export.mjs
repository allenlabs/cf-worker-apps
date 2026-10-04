/** Explicit bounded export. Never overwrite a file and never claim a partial export is complete. */
import { open } from 'node:fs/promises';
const options = Object.fromEntries(process.argv.slice(2).map(x => {
    const [k, ...v] = x.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
}));
const origin = process.env.OBSERVE_URL, token = process.env.VIEWER_TOKEN;
if (!origin || !token || !options.from || !options.to || !options.out) {
    console.error('OBSERVE_URL=... VIEWER_TOKEN=... node scripts/export.mjs --from=2026-09-08T00:00:00Z --to=2026-09-08T01:00:00Z --out=export.ndjson [--raw=true] [--maxPages=1000]');
    process.exit(1);
}
const from = Date.parse(options.from), to = Date.parse(options.to), max = Number(options.maxPages || 1000);
if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > to || !Number.isInteger(max) || max < 1)
    throw new Error('Invalid export range or page limit');
const originURL = new URL(origin);
if (originURL.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(originURL.hostname))
    throw new Error('Remote exports require HTTPS');
async function get(path) {
    const r = await fetch(new URL(path, originURL), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    if (!r.ok)
        throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
}
const file = await open(options.out, 'wx', 0o600);
let count = 0, cursor = null, complete = false;
try {
    for (let page = 0; page < max; page++) {
        const params = new URLSearchParams({ from: String(from), to: String(to), limit: '500' });
        for (const k of ['q', 'service', 'kind', 'traceId'])
            if (options[k])
                params.set(k, options[k]);
        if (cursor)
            params.set('cursor', cursor);
        const data = await get('/api/events?' + params);
        for (const event of data.events) {
            const value = options.raw === 'true' ? await get('/api/event?' + new URLSearchParams({ id: event.id, seq: String(event.seq), receivedAt: String(event.receivedAt) })) : event;
            await file.write(JSON.stringify(value) + '\n');
            count++;
        }
        if (data.complete) {
            complete = true;
            break;
        }
        if (!data.nextCursor || data.nextCursor === cursor)
            throw new Error('Pagination did not advance');
        cursor = data.nextCursor;
    }
    if (!complete)
        throw new Error('maxPages reached. Output is PARTIAL; narrow the range or raise the explicit page cap.');
    console.log(`Complete: ${count} ${options.raw === 'true' ? 'raw records' : 'previews'} exported to ${options.out}`);
}
catch (e) {
    console.error(`PARTIAL OUTPUT (${count} rows): ${e.message}`);
    process.exitCode = 1;
}
finally {
    await file.close();
}
