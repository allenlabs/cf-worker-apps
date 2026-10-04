import { normalize, preview } from './protocol.js';
import { matches } from './query.js';
import { persistJob, newJob } from './segments.js';
import { HttpError, json, errorResponse, sha256, utf8, configuredInt, hourStart, unbase64url } from './util.js';
// Fetch-based Durable Object class: no Node APIs or runtime dependencies.
export class TelemetryJournal {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = ctx.storage.sql;
        this.running = null;
        this.sql.exec('CREATE TABLE IF NOT EXISTS pending (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, received_at INTEGER NOT NULL, signal TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, event_count INTEGER NOT NULL)');
        this.sql.exec('CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, hash TEXT NOT NULL, batch_id TEXT NOT NULL, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
        this.sql.exec('CREATE INDEX IF NOT EXISTS receipt_expiry ON receipts(expires_at)');
        this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.sql.exec('CREATE TABLE IF NOT EXISTS source_stats (source_id TEXT PRIMARY KEY, last_received_at INTEGER NOT NULL, accepted_batches INTEGER NOT NULL, accepted_events INTEGER NOT NULL, accepted_bytes INTEGER NOT NULL)');
    }
    rows(q, ...args) {
        return this.sql.exec(q, ...args).toArray();
    }
    getMeta(key, fallback = null) {
        const row = this.rows('SELECT value FROM meta WHERE key = ?', key)[0];
        return row ? JSON.parse(row.value) : fallback;
    }
    setMeta(key, value) {
        this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
    }
    health() {
        const r = this.rows('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(event_count),0) AS events, MIN(received_at) AS oldest FROM pending')[0];
        const maxPendingBytes = configuredInt(this.env.MAX_PENDING_BYTES, 16 * 1024 * 1024, 1024, 128 * 1024 * 1024);
        const maxPendingBatches = 256;
        const sources = this.rows('SELECT source_id AS sourceId, last_received_at AS lastReceivedAt, accepted_batches AS acceptedBatches, accepted_events AS acceptedEvents, accepted_bytes AS acceptedBytes FROM source_stats ORDER BY last_received_at DESC');
        return { serverNow: Date.now(), sources, maxPendingBytes, maxPendingBatches, pendingUtilization: Math.max(r.bytes / maxPendingBytes, r.n / maxPendingBatches), nextRetryAt: this.getMeta('nextRetryAt'), rejectedBatches: this.getMeta('rejectedBatches', 0), pendingBatches: r.n, pendingBytes: r.bytes, pendingEvents: r.events, oldestPendingAt: r.oldest, lastArchivedAt: this.getMeta('lastArchivedAt'), lastArchivedSeq: this.getMeta('lastArchivedSeq', 0), lastError: this.getMeta('lastError'), failureCount: this.getMeta('failureCount', 0), r2FlushMs: configuredInt(this.env.R2_FLUSH_MS, 10000, 1000, 60000), storage: 'R2 permanent archive + temporary durable SQLite outbox' };
    }
    async ensureAlarm(delay) {
        const when = Math.max(Date.now() + delay, this.getMeta('nextRetryAt', 0) || 0);
        const prior = await this.ctx.storage.getAlarm();
        if (prior === null || prior > when)
            await this.ctx.storage.setAlarm(when);
    }
    async ingest(input, idempotencyKey = '', legacyDigest = '') {
        input = { ...input, sourceId: input.sourceId || 'legacy' };
        if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.sourceId))
            throw new HttpError(400, 'Invalid ingestion source');
        const events = normalize(input);
        const serialized = JSON.stringify(input);
        const bytes = utf8.encode(serialized).length;
        if (bytes > 1536 * 1024)
            throw new HttpError(413, 'Decoded export is too large; reduce exporter batch size');
        const digest = idempotencyKey ? await sha256(JSON.stringify({ signal: input.signal, payload: input.payload, wireBase64: input.wireBase64 })) : '';
        const key = idempotencyKey ? await sha256(JSON.stringify([input.sourceId, idempotencyKey])) : '';
        // Existing deployed receipts predate source IDs. Only the legacy identity may reuse them.
        const legacyKey = idempotencyKey && input.sourceId === 'legacy' ? await sha256(idempotencyKey) : '';
        const flushMs = configuredInt(this.env.R2_FLUSH_MS, 10000, 1000, 60000);
        const receiptDays = configuredInt(this.env.RECEIPT_RETENTION_DAYS, 1, 1, 30);
        const before = this.health();
        const pressure = before.pendingBytes + bytes >= Math.min(4 * 1024 * 1024, before.maxPendingBytes * 0.75) || before.pendingBatches + 1 >= 64;
        // Schedule first: the durable acknowledgment never leaves an accepted batch without a wakeup.
        await this.ensureAlarm(pressure ? 1 : flushMs);
        const result = this.ctx.storage.transactionSync(() => {
            if (key) {
                const current = this.rows('SELECT * FROM receipts WHERE key = ? AND expires_at > ?', key, Date.now())[0];
                const legacy = !current && legacyKey ? this.rows('SELECT * FROM receipts WHERE key = ? AND expires_at > ?', legacyKey, Date.now())[0] : null;
                const prior = current || legacy;
                if (prior) {
                    if (prior.hash !== (legacy ? legacyDigest || digest : digest))
                        throw new HttpError(409, 'Idempotency-Key was reused with different data');
                    return { batchId: prior.batch_id, seq: prior.seq, duplicate: true, events: events.length, durability: 'temporary-durable-buffer' };
                }
            }
            const h = this.health();
            if (h.pendingBytes + bytes > h.maxPendingBytes || h.pendingBatches >= h.maxPendingBatches)
                throw new HttpError(503, 'Durable buffer is full; retry with exponential backoff. No data was accepted');
            if (!h.sources.some(source => source.sourceId === input.sourceId) && h.sources.length >= 65)
                throw new HttpError(503, 'Source history capacity reached; review configured source IDs');
            const inserted = this.rows('INSERT INTO pending(id,received_at,signal,payload,bytes,event_count) VALUES(?,?,?,?,?,?) RETURNING seq', input.id, input.receivedAt, input.signal, serialized, bytes, events.length)[0];
            this.sql.exec('INSERT INTO source_stats(source_id,last_received_at,accepted_batches,accepted_events,accepted_bytes) VALUES(?,?,1,?,?) ON CONFLICT(source_id) DO UPDATE SET last_received_at=MAX(source_stats.last_received_at,excluded.last_received_at),accepted_batches=source_stats.accepted_batches+1,accepted_events=source_stats.accepted_events+excluded.accepted_events,accepted_bytes=source_stats.accepted_bytes+excluded.accepted_bytes', input.sourceId, input.receivedAt, events.length, bytes);
            if (key)
                this.sql.exec('INSERT INTO receipts(key,hash,batch_id,seq,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET hash=excluded.hash,batch_id=excluded.batch_id,seq=excluded.seq,expires_at=excluded.expires_at', key, digest, input.id, inserted.seq, Date.now() + receiptDays * 86400000);
            return { batchId: input.id, seq: inserted.seq, duplicate: false, events: events.length, durability: 'temporary-durable-buffer' };
        });
        // SQL output gates also provide this ordering; an explicit sync makes the contract clear.
        await this.ctx.storage.sync();
        if (!result.duplicate)
            this.publishEvents(events.map(e => ({ ...e, seq: result.seq })));
        return result;
    }
    snapshot(from, to) {
        return { watermark: this.rows("SELECT seq FROM sqlite_sequence WHERE name='pending'")[0]?.seq ?? 0, batches: this.rows('SELECT seq,id,received_at,signal,bytes,event_count FROM pending WHERE received_at >= ? AND received_at <= ? ORDER BY seq DESC', from, to) };
    }
    batch(seq) {
        const row = this.rows('SELECT seq,payload FROM pending WHERE seq = ?', seq)[0];
        return row ? { ...JSON.parse(row.payload), seq: row.seq } : null;
    }
    async alarm() {
        if (this.running)
            return this.running;
        this.running = this.flush().finally(() => {
            this.running = null;
        });
        return this.running;
    }
    async flush() {
        try {
            let job = this.getMeta('job');
            let rows;
            if (job) {
                rows = this.rows('SELECT * FROM pending WHERE seq >= ? AND seq <= ? ORDER BY seq', job.firstSeq, job.lastSeq);
                if (!rows.length)
                    throw new Error('Stored job is inconsistent');
            }
            else {
                const candidates = this.rows('SELECT * FROM pending ORDER BY seq LIMIT 64');
                rows = [];
                let bytes = 0;
                for (const row of candidates) {
                    if (rows.length && (bytes + row.bytes > 4 * 1024 * 1024 || hourStart(row.received_at) !== hourStart(rows[0].received_at)))
                        break;
                    rows.push(row);
                    bytes += row.bytes;
                }
                if (!rows.length) {
                    this.sql.exec('DELETE FROM receipts WHERE expires_at <= ?', Date.now());
                    return;
                }
                job = newJob(this.env, rows);
                this.setMeta('job', job);
                await this.ctx.storage.sync();
            }
            const batches = rows.map(row => ({ ...JSON.parse(row.payload), seq: row.seq }));
            await persistJob(this.env, job, batches);
            // No external I/O in this transaction. R2 data and its index are already durable.
            this.ctx.storage.transactionSync(() => {
                this.sql.exec('DELETE FROM pending WHERE seq >= ? AND seq <= ?', job.firstSeq, job.lastSeq);
                this.sql.exec("DELETE FROM meta WHERE key='job'");
                this.setMeta('lastArchivedAt', Date.now());
                this.setMeta('lastArchivedSeq', job.lastSeq);
                this.setMeta('lastError', null);
                this.setMeta('failureCount', 0);
                this.setMeta('nextRetryAt', null);
                this.sql.exec('DELETE FROM receipts WHERE expires_at <= ?', Date.now());
            });
            await this.ctx.storage.sync();
            this.broadcast({ type: 'persisted', throughSeq: job.lastSeq });
            if (this.health().pendingBatches)
                await this.ensureAlarm(1);
        }
        catch {
            const n = this.getMeta('failureCount', 0) + 1;
            this.setMeta('failureCount', n);
            this.setMeta('lastError', 'R2 flush failed; accepted data remains in the durable buffer');
            const retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(n, 6));
            this.setMeta('nextRetryAt', retryAt);
            await this.ctx.storage.setAlarm(retryAt);
        }
    }
    publishEvents(events) {
        for (const ws of this.ctx.getWebSockets()) {
            try {
                const attachment = ws.deserializeAttachment();
                if ((attachment?.exp ?? 0) <= Date.now()) {
                    ws.close(4001, 'Session expired');
                    continue;
                }
                const filters = { from: 0, to: 8640000000000000, ...attachment.filters };
                const list = events.filter(e => matches(e, filters)).map(e => ({ ...preview(e), storage: 'buffer' }));
                for (let i = 0; i < list.length; i += 100)
                    ws.send(JSON.stringify({ type: 'events', events: list.slice(i, i + 100) }));
            }
            catch {
                try {
                    ws.close(1011, 'Reconnect and reload history');
                }
                catch {
                }
            }
        }
    }
    broadcast(message) {
        const data = JSON.stringify(message);
        for (const ws of this.ctx.getWebSockets()) {
            try {
                if ((ws.deserializeAttachment()?.exp ?? 0) <= Date.now()) {
                    ws.close(4001, 'Session expired');
                    continue;
                }
                ws.send(data);
            }
            catch {
                try {
                    ws.close(1011, 'Reconnect and reload history');
                }
                catch {
                }
            }
        }
    }
    webSocketMessage(ws, message) {
        if ((ws.deserializeAttachment()?.exp ?? 0) <= Date.now()) {
            ws.close(4001, 'Session expired');
            return;
        }
        if (message === 'ping')
            ws.send('pong');
        else
            ws.close(1008, 'Read-only connection');
    }
    webSocketClose(ws, code) {
        try {
            ws.close(code, 'Closed');
        }
        catch {
        }
    }
    webSocketError(ws) {
        try {
            ws.close(1011, 'Reconnect');
        }
        catch {
        }
    }
    async fetch(request) {
        const ingestion = new URL(request.url).pathname === '/ingest';
        try {
            const url = new URL(request.url);
            if (url.pathname === '/ingest' && request.method === 'POST') {
                const { batch, idempotencyKey, legacyDigest } = await request.json();
                return json(await this.ingest(batch, idempotencyKey, legacyDigest));
            }
            if (url.pathname === '/health')
                return json(this.health());
            if (url.pathname === '/snapshot') {
                const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
                if (!Number.isFinite(from) || !Number.isFinite(to))
                    throw new HttpError(400, 'Invalid snapshot range');
                return json(this.snapshot(from, to));
            }
            if (url.pathname === '/batch') {
                const seq = Number(url.searchParams.get('seq'));
                if (!Number.isSafeInteger(seq) || seq < 1)
                    throw new HttpError(400, 'Invalid batch sequence');
                const b = this.batch(seq);
                return b ? json(b) : json({ error: 'Batch has moved to R2' }, 404);
            }
            if (url.pathname === '/kick') {
                if (this.health().pendingBatches || this.getMeta('job'))
                    await this.ensureAlarm(1);
                return json(this.health());
            }
            if (url.pathname === '/subscribe' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                const exp = Number(request.headers.get('x-session-exp'));
                if (!Number.isFinite(exp) || exp <= Date.now())
                    throw new HttpError(401, 'Session expired');
                if (this.ctx.getWebSockets().length >= 20)
                    throw new HttpError(429, 'At most 20 live viewers per dataset');
                const pair = new WebSocketPair();
                const [client, server] = Object.values(pair);
                const encoded = request.headers.get('x-live-filters');
                const filters = encoded ? JSON.parse(new TextDecoder().decode(unbase64url(encoded))) : {};
                server.serializeAttachment({ exp, filters });
                this.ctx.acceptWebSocket(server);
                server.send(JSON.stringify({ type: 'hello', health: this.health() }));
                return new Response(null, { status: 101, webSocket: client });
            }
            throw new HttpError(404, 'Not found');
        }
        catch (e) {
            if (ingestion && e instanceof HttpError && e.status === 503)
                this.setMeta('rejectedBatches', this.getMeta('rejectedBatches', 0) + 1);
            return errorResponse(ingestion && !(e instanceof HttpError) ? new HttpError(503, 'Durable ingestion is temporarily unavailable; retry with backoff') : e);
        }
    }
}
