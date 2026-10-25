export const MAX_BODY = 256 * 1024;
export const encoder = new TextEncoder();
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
export function publicOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_ORIGIN);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === env.PUBLIC_ORIGIN ? url.origin : null;
  } catch { return null; }
}
export const fail = (message, code = -32602, data) => { throw Object.assign(new Error(message), { code, data }); };
export const canonical = args => JSON.stringify(Object.fromEntries(Object.keys(args).sort().map(key => [key, args[key]])));
export const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function equal(left, right) {
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(left)), crypto.subtle.digest('SHA-256', encoder.encode(right))]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
export async function bodyBytes(request, limit = MAX_BODY) {
  if (Number(request.headers.get('content-length')) > limit) fail('Request body too large', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail('Request body too large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export const bodyText = async (request, limit) => new TextDecoder('utf-8', { fatal: true }).decode(await bodyBytes(request, limit));
export function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) fail('Invalid webhook signing secret');
  let bytes;
  try { bytes = Uint8Array.from(atob(secret.slice(6)), char => char.charCodeAt(0)); } catch { fail('Invalid webhook signing secret'); }
  if (bytes.length < 24 || bytes.length > 64) fail('Signing key must contain 24–64 bytes');
  return bytes;
}
export function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid callback URL'); }
  // ponytail: trusted OpenAI domains only; add a reviewed provider allowlist to support other MCP clients.
  const trusted = ['chatgpt.com', 'openai.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (url.protocol !== 'https:' || !trusted || url.username || url.password || url.hash || (url.port && url.port !== '443')) fail('Callback must use a trusted OpenAI HTTPS endpoint', -32602, { callbackHost: url.hostname });
  return url.href;
}
export async function sendSigned(subscription, body, id) {
  if (encoder.encode(body).byteLength > MAX_BODY) fail('Event body too large', 413);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secrets = [subscription.delivery.secret];
  if (subscription.previousSecret && subscription.rotationUntil > Date.now()) secrets.push(subscription.previousSecret);
  const signatures = await Promise.all(secrets.map(async secret => {
    const key = await crypto.subtle.importKey('raw', signingKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${body}`)));
    return `v1,${btoa(String.fromCharCode(...bytes))}`;
  }));
  return fetch(callbackUrl(subscription.delivery.url), {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), body,
    headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id }
  });
}
