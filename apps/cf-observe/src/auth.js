import { HttpError, utf8, base64url, unbase64url, datasetName, bytesLimited, json, errorResponse } from './util.js';
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
function viewerCookie(request, token, maxAge, sameSite = 'Strict') {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `${cookieName(request)}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`;
}
export async function authorizeViewer(request, env) {
    requireSecrets(env);
    const token = bearer(request), sso = ssoConfig(env);
    const browser = request.headers.has('origin') || [...request.headers.keys()].some(name => name.startsWith('sec-fetch-'));
    if (token && !(sso && browser) && await equal(token, env.VIEWER_TOKEN))
        return { purpose: 'session', exp: Date.now() + 8 * 3600000 };
    const cookie = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName(request) + '='))?.split('=').slice(1).join('=');
    const session = await verify(env, cookie, 'session');
    if (sso && (session.sso !== true || !sso.subjects.includes(session.subject) || session.issuer !== sso.api || session.origin !== new URL(request.url).origin))
        throw new HttpError(401, 'SSO session required');
    return session;
}
export async function login(request, env) {
    requireSecrets(env);
    requireSameOrigin(request);
    if (ssoConfig(env))
        throw new HttpError(403, 'Use SSO to sign in');
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
    return json({ ok: true, expiresAt: exp }, 200, { 'set-cookie': viewerCookie(request, token, 28800) });
}
export function logout(request) {
    requireSameOrigin(request);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `${cookieName(request)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
}

function validSubject(value) {
    return typeof value === 'string' && value.length > 0 && utf8.encode(value).length <= 255 && !/[\s\x00-\x1f\x7f]/.test(value);
}
export function ssoConfig(env) {
    if ([env.SSO_WEB_ORIGIN, env.SSO_API_ORIGIN, env.SSO_ALLOWED_SUBJECTS, env.AUTH_API].every(value => value === undefined))
        return null;
    try {
        for (const value of [env.SSO_WEB_ORIGIN, env.SSO_API_ORIGIN]) {
            const url = new URL(value);
            if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.origin !== value)
                throw 0;
        }
        if (typeof env.SSO_ALLOWED_SUBJECTS !== 'string' || env.SSO_ALLOWED_SUBJECTS.length > 65536 || (env.AUTH_API !== undefined && typeof env.AUTH_API?.fetch !== 'function'))
            throw 0;
        const subjects = JSON.parse(env.SSO_ALLOWED_SUBJECTS);
        if (!Array.isArray(subjects) || !subjects.length || subjects.length > 100 || subjects.some(value => !validSubject(value)) || new Set(subjects).size !== subjects.length)
            throw 0;
        return { web: env.SSO_WEB_ORIGIN, api: env.SSO_API_ORIGIN, subjects };
    }
    catch { throw new HttpError(503, 'Invalid SSO configuration'); }
}
const ssoStateCookie = '__Host-cf_observe_sso_state';
const stateCookie = (value, maxAge) => `${ssoStateCookie}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
export async function ssoLogin(request, env, config) {
    requireSecrets(env);
    const origin = new URL(request.url).origin;
    if (!origin.startsWith('https://'))
        throw new HttpError(503, 'SSO requires HTTPS');
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const callback = new URL('/auth/callback', origin);
    callback.searchParams.set('state', state);
    const target = new URL('/sign-in', config.web);
    target.searchParams.set('return_to', callback.href);
    const proof = await sign(env, { purpose: 'sso-state', origin, state, exp: Date.now() + 600000 });
    return new Response(null, { status: 303, headers: { location: target.href, 'cache-control': 'no-store', 'set-cookie': stateCookie(proof, 600) } });
}
export async function ssoCallback(request, env, config) {
    let result;
    try {
        requireSecrets(env);
        const url = new URL(request.url), params = url.searchParams;
        const code = params.get('code'), state = params.get('state');
        if (url.protocol !== 'https:' || params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || [...params.keys()].some(key => !['code', 'state'].includes(key)) || !/^[A-Za-z0-9_-]{43}$/.test(state || '') || typeof code !== 'string' || !code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code))
            throw new HttpError(400, 'Invalid SSO callback; start sign-in again');
        const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(ssoStateCookie + '='));
        if (cookies.length !== 1)
            throw new HttpError(401, 'Invalid or expired SSO state');
        const proof = await verify(env, cookies[0].slice(ssoStateCookie.length + 1), 'sso-state');
        if (proof.origin !== url.origin || proof.state !== state)
            throw new HttpError(401, 'Invalid or expired SSO state');
        let response;
        try {
            const exchange = new Request(new URL('/sso/exchange', config.api), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, client_id: url.origin, include_token: false }), redirect: 'manual', signal: AbortSignal.timeout(5000) });
            response = await (env.AUTH_API ? env.AUTH_API.fetch(exchange) : fetch(exchange));
        }
        catch { throw new HttpError(503, 'SSO sign-in is temporarily unavailable'); }
        if (response.status !== 200)
            throw new HttpError(response.status >= 500 ? 503 : 401, 'SSO sign-in exchange failed');
        let data;
        try {
            if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') || ''))
                throw 0;
            data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytesLimited(response.body, 16384)));
            if (!validSubject(data?.user?.id) || (data.token !== undefined && data.token !== '') || (data.expires_in !== undefined && !(data.token === '' && data.expires_in === 0) && (!Number.isSafeInteger(data.expires_in) || data.expires_in <= 0)))
                throw 0;
        }
        catch { throw new HttpError(502, 'Invalid SSO sign-in response'); }
        if (!config.subjects.includes(data.user.id))
            throw new HttpError(403, 'This account cannot view this dashboard');
        const maxAge = Math.min(28800, data.expires_in || 28800);
        const token = await sign(env, { purpose: 'session', sso: true, subject: data.user.id, issuer: config.api, origin: url.origin, exp: Date.now() + maxAge * 1000 });
        result = new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store', 'set-cookie': viewerCookie(request, token, maxAge, 'Lax') } });
    }
    catch (error) { result = errorResponse(error); }
    result.headers.append('set-cookie', stateCookie('', 0));
    return result;
}
