/** LOCAL-ONLY preview harness. SQLite is real; R2 and DO scheduling are emulated.
 * Never deploy this server. No claims about Cloudflare runtime timing follow from it.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { TelemetryJournal } from '../src/journal.js';
import { authorizeViewer, requireSameOrigin } from '../src/auth.js';
import { makeContext, makeEnv, attachNamespace } from '../tests/helpers.js';
import { demoBatch } from './demo-data.mjs';
const PORT = Number(process.env.PORT || 8788), HOST = '127.0.0.1';
const env = makeEnv({ DATASET: 'demo', R2_FLUSH_MS: '10000', LOCAL_DEMO: 'true', INGEST_TOKEN: 'local-only-demo-ingest-token-0000000000000000', VIEWER_TOKEN: 'local-only-demo-viewer-token-0000000000000000' });
const ctx = makeContext(), journal = new TelemetryJournal(ctx, env);
attachNamespace(env, journal);
const root = fileURLToPath(new URL('../public/', import.meta.url));
env.ASSETS = { async fetch(request) {
        const url = new URL(request.url);
        const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const full = path.resolve(root, name);
        if (!full.startsWith(root))
            return new Response('Not found', { status: 404 });
        try {
            const data = await readFile(full);
            const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(name)] || 'application/octet-stream';
            return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
        }
        catch {
            return new Response('Not found', { status: 404 });
        }
    } };
for (let i = 0; i < 420; i++) {
    await journal.ingest(demoBatch(i));
    if (i % 40 === 39)
        await journal.alarm();
}
while (journal.health().pendingBatches)
    await journal.alarm();
function webRequest(req, body) {
    return new Request(`http://${HOST}:${PORT}${req.url}`, { method: req.method, headers: req.headers, ...(body?.length ? { body } : {}) });
}
const server = http.createServer(async (req, res) => {
    try {
        let length = 0;
        const chunks = [];
        for await (const c of req) {
            length += c.length;
            if (length > 2 * 1024 * 1024) {
                res.writeHead(413);
                res.end();
                return;
            }
            chunks.push(c);
        }
        const response = await worker.fetch(webRequest(req, Buffer.concat(chunks)), env, {});
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    }
    catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
});
function frame(text, opcode = 1) {
    const b = Buffer.from(text);
    let h;
    if (b.length < 126)
        h = Buffer.from([0x80 | opcode, b.length]);
    else if (b.length <= 65535) {
        h = Buffer.alloc(4);
        h[0] = 0x80 | opcode;
        h[1] = 126;
        h.writeUInt16BE(b.length, 2);
    }
    else {
        h = Buffer.alloc(10);
        h[0] = 0x80 | opcode;
        h[1] = 127;
        h.writeBigUInt64BE(BigInt(b.length), 2);
    }
    return Buffer.concat([h, b]);
}
server.on('upgrade', async (req, socket) => {
    try {
        const request = webRequest(req);
        requireSameOrigin(request, true);
        const session = await authorizeViewer(request, env);
        const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const filters = Object.fromEntries(new URL(request.url).searchParams);
        const ws = { deserializeAttachment: () => ({ exp: session.exp, filters }), send: s => {
                if (socket.writable)
                    socket.write(frame(s));
            }, close: () => socket.end(frame('', 8)) };
        ctx.acceptWebSocket(ws);
        ws.send(JSON.stringify({ type: 'hello', health: { ...journal.health(), demo: true } }));
        const remove = () => {
            const all = ctx.getWebSockets(), i = all.indexOf(ws);
            if (i >= 0)
                all.splice(i, 1);
        };
        socket.on('close', remove);
        socket.on('error', remove);
        socket.on('data', b => {
            if ((b[0] & 15) === 8)
                ws.close();
        });
    }
    catch {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
});
let tick = 420;
const producer = setInterval(async () => {
    try {
        const index = (tick++) % 420;
        const b = demoBatch(index, Date.now() + (420 - index) * 5000);
        await journal.ingest(b);
    }
    catch {
    }
}, 1500);
const alarm = setInterval(async () => {
    const when = await ctx.storage.getAlarm();
    if (when !== null && when <= Date.now()) {
        ctx._fire();
        await journal.alarm();
    }
}, 100);
server.listen(PORT, HOST, () => console.log(`LOCAL DEMO ONLY: http://${HOST}:${PORT}\nViewer token: ${env.VIEWER_TOKEN}\nSynthetic fixtures; no Cloudflare resources are used.`));
process.on('SIGTERM', () => {
    clearInterval(producer);
    clearInterval(alarm);
    server.close();
    process.exit(0);
});
