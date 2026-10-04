import { HttpError, utf8, base64url, unbase64url, datasetName, bytesLimited, json } from './util.js';
export function requireSecrets(env) {
    if (!validSecret(env.VIEWER_TOKEN))
        throw new HttpError(503, 'Set a random VIEWER_TOKEN of at least 32 characters');
    const sources = sourceCredentials(env);
    if (env.INGEST_TOKEN !== undefined && (!validSecret(env.INGEST_TOKEN) || env.INGEST_TOKEN === env.VIEWER_TOKEN))
        throw new HttpError(503, 'Set different INGEST_TOKEN and VIEWER_TOKEN secrets, each at least 32 characters');
    if (!env.INGEST_TOKEN && !sources.length)
        throw new HttpError(503, 'Configure INGEST_TOKEN or SOURCE_TOKENS for ingestion');
}
function validSecret(value) {
    return typeof value === 'string' && value.length >= 32 && value.length <= 512 && !/\s/.test(value) && !/^(replace[-_ ]|change[-_ ]?me)/i.test(value);
}
/** Source IDs are trusted server configuration, never supplied by telemetry. */
export function sourceCredentials(env) {
    if (env.SOURCE_TOKENS === undefined)
        return [];
    try {
        if (typeof env.SOURCE_TOKENS !== 'string' || env.SOURCE_TOKENS.length > 65536)
            throw 0;
        const parsed = JSON.parse(env.SOURCE_TOKENS);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw 0;
        const entries = Object.entries(parsed);
        if (entries.length > 64)
            throw 0;
        const tokens = new Set([env.VIEWER_TOKEN, env.INGEST_TOKEN]);
        return entries.map(([sourceId, config]) => {
            if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(sourceId) || sourceId === 'legacy' || !config || typeof config !== 'object' || Array.isArray(config) || !validSecret(config.token) || tokens.has(config.token) || (config.enabled !== undefined && typeof config.enabled !== 'boolean'))
                throw 0;
            tokens.add(config.token);
            return { sourceId, token: config.token, enabled: config.enabled !== false };
        });
    }
    catch {
        throw new HttpError(503, 'Invalid SOURCE_TOKENS configuration; use at most 64 unique source credentials');
    }
}
async function equal(a, b) {
    const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', utf8.encode(s))));
    let n = 0;
    const u = new Uint8Array(x), v = new Uint8Array(y);
    for (let i = 0; i < u.length; i++)
        n |= u[i] ^ v[i];
    return n === 0;
}
async function key(env) {
    return crypto.subtle.importKey('raw', utf8.encode(env.VIEWER_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(env, claims) {
    const encoded = base64url(utf8.encode(JSON.stringify({ ...claims, dataset: datasetName(env) })));
    const mac = await crypto.subtle.sign('HMAC', await key(env), utf8.encode(encoded));
    return `${encoded}.${base64url(new Uint8Array(mac))}`;
}
export async function verify(env, token, purpose) {
    try {
        if (typeof token !== 'string' || token.length > 8192)
            throw 0;
        const parts = token.split('.');
        if (parts.length !== 2)
            throw 0;
        if (!await crypto.subtle.verify('HMAC', await key(env), unbase64url(parts[1]), utf8.encode(parts[0])))
            throw 0;
        const c = JSON.parse(new TextDecoder().decode(unbase64url(parts[0])));
        if (c.dataset !== datasetName(env) || c.purpose !== purpose || !Number.isFinite(c.exp) || c.exp <= Date.now())
            throw 0;
        return c;
    }
    catch {
        throw new HttpError(401, 'Invalid or expired credentials');
    }
}
export function requireSameOrigin(request, required = false) {
    const origin = request.headers.get('origin');
    if ((required && !origin) || (origin && origin !== new URL(request.url).origin))
        throw new HttpError(403, 'Cross-origin request denied');
}
function bearer(request) {
    return request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
}
export async function authorizeIngest(request, env) {
    requireSecrets(env);
    const token = bearer(request);
    if (token && env.INGEST_TOKEN && await equal(token, env.INGEST_TOKEN))
        return { sourceId: 'legacy' };
    for (const source of sourceCredentials(env))
        if (token && source.enabled && await equal(token, source.token))
            return { sourceId: source.sourceId };
    throw new HttpError(401, 'Valid ingestion Bearer token required');
}
const cookieName = request => new URL(request.url).protocol === 'https:' ? '__Host-cf_observe' : 'cf_observe_local';
export async function authorizeViewer(request, env) {
    requireSecrets(env);
    const token = bearer(request);
    if (token && await equal(token, env.VIEWER_TOKEN))
        return { purpose: 'session', exp: Date.now() + 8 * 3600000 };
    const cookie = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName(request) + '='))?.split('=').slice(1).join('=');
    return verify(env, cookie, 'session');
}
export async function login(request, env) {
    requireSecrets(env);
    requireSameOrigin(request);
    let body;
    try {
        body = JSON.parse(new TextDecoder().decode(await bytesLimited(request.body, 4096)));
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(400, 'Invalid login body');
    }
    if (typeof body.token !== 'string' || !await equal(body.token, env.VIEWER_TOKEN))
        throw new HttpError(401, 'Invalid viewer token');
    const exp = Date.now() + 8 * 3600000, token = await sign(env, { purpose: 'session', exp });
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true, expiresAt: exp }, 200, { 'set-cookie': `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
}
export function logout(request) {
    requireSameOrigin(request);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `${cookieName(request)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
}
