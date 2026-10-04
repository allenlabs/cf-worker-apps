import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../src/util.js';
export class MemoryR2 {
    constructor() {
        this.objects = new Map();
        this.calls = [];
        this.fail = null;
        this.beforeGet = null;
    }
    async put(key, value, options = {}) {
        this.calls.push(['put', key]);
        if (this.fail?.('put', key))
            throw new Error('Injected R2 failure');
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
        this.objects.set(key, { bytes: bytes.slice(), options, etag: await sha256(bytes) });
        return { key };
    }
    async get(key) {
        this.calls.push(['get', key]);
        if (this.beforeGet)
            await this.beforeGet(key);
        if (this.fail?.('get', key))
            throw new Error('Injected R2 failure');
        const o = this.objects.get(key);
        if (!o)
            return null;
        return { key, size: o.bytes.length, etag: o.etag, body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.slice().buffer, text: async () => new TextDecoder().decode(o.bytes), json: async () => JSON.parse(new TextDecoder().decode(o.bytes)) };
    }
}
export function makeContext(db = new DatabaseSync(':memory:')) {
    let alarm = null;
    const sockets = [];
    const sql = { exec(query, ...bindings) {
            const stmt = db.prepare(query);
            const arr = stmt.all(...bindings);
            return { toArray: () => arr, one: () => {
                    if (arr.length !== 1)
                        throw new Error('Expected one row');
                    return arr[0];
                }, [Symbol.iterator]: () => arr[Symbol.iterator]() };
        } };
    const storage = { sql, transactionSync(fn) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const v = fn();
                db.exec('COMMIT');
                return v;
            }
            catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        }, sync: async () => {
        }, getAlarm: async () => alarm, setAlarm: async (n) => {
            alarm = Number(n);
        }, deleteAlarm: async () => {
            alarm = null;
        } };
    return { db, storage, getWebSockets: () => sockets, acceptWebSocket: s => sockets.push(s), blockConcurrencyWhile: fn => fn(), waitUntil: () => {
        }, _fire: () => {
            alarm = null;
        } };
}
export const makeBatch = (n = 1, receivedAt = Date.now(), extra = {}) => ({ id: crypto.randomUUID(), receivedAt, signal: 'events', encoding: 'json', payload: Array.from({ length: n }, (_, i) => ({ service: 'test-service', message: `event ${i}`, value: i })), ...extra });
export function makeEnv(extra = {}) {
    return { DATASET: 'test', R2_FLUSH_MS: '10000', INGEST_TOKEN: 'i'.repeat(48), VIEWER_TOKEN: 'v'.repeat(48), ARCHIVE: new MemoryR2(), ...extra };
}
export function attachNamespace(env, journal) {
    const stub = { fetch: req => journal.fetch(typeof req === 'string' ? new Request(req) : req) };
    env.JOURNAL = { idFromName: x => x, get: () => stub };
    return stub;
}
