// Real-time collaboration backend.
//
// One Yjs document per Durable Object (y-durableobjects, y-websocket
// compatible). Any app embeds @allenlabs/editor and points its y-websocket
// provider at  wss://<this-worker>/editor/<docId>?token=<t> .
//
// The doc id is opaque to us — callers namespace it however they like
// (e.g. "pm-issue-42"). The DO persists the doc across hibernation via the
// library's built-in transaction storage; no external store needed for v1.
//
// Auth: every WS upgrade must carry a short-lived HMAC token minted by the
// embedding app (which holds the user's session). The token binds a specific
// doc id + expiry, so a leaked token can't be replayed against other docs or
// after it expires. The shared secret is the COLLAB_HMAC_SECRET wrangler
// secret, mirrored by each consuming app.

import { Hono } from 'hono';
import { YDurableObjects, yRoute } from 'y-durableobjects';

export { YDurableObjects };

interface Env {
  Bindings: {
    Y_DURABLE_OBJECTS: DurableObjectNamespace;
    COLLAB_HMAC_SECRET: string;
  };
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface CollabClaims {
  room: string; // doc id this token is valid for
  exp: number; // unix seconds
  uid?: string;
  name?: string;
}

/**
 * Verify a `<b64url(payload)>.<b64url(hmac)>` token against the shared secret.
 * Returns the claims when valid + unexpired + bound to `room`, else null.
 */
async function verifyToken(
  token: string | undefined,
  room: string,
  secret: string,
): Promise<CollabClaims | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigPart),
      new TextEncoder().encode(payloadPart),
    );
    if (!ok) return null;
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadPart)),
    ) as CollabClaims;
    if (claims.room !== room) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

const app = new Hono<Env>();

app.get('/health', (c) => c.json({ ok: true, service: 'allenlabs-collab' }));

// Gate the WS upgrade: the token must be valid AND bound to this exact doc id.
app.use('/editor/:id', async (c, next) => {
  const room = c.req.param('id');
  const token = c.req.query('token') ?? undefined;
  const claims = await verifyToken(token, room, c.env.COLLAB_HMAC_SECRET);
  if (!claims) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.route('/editor', yRoute<Env>((env) => env.Y_DURABLE_OBJECTS));

export default app;
