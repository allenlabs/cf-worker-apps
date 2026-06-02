// HMAC middleware for the editor API worker.
//
// Every /v1/* request must carry:
//   X-Timestamp   ms-since-epoch as a Number string
//   X-Signature   base64 HMAC-SHA256(`${timestamp}\n${body}`, EDITOR_HMAC_SECRET)
//
// A single shared secret (EDITOR_HMAC_SECRET) gates every call — no per-client
// table. The signed JSON body carries the user identity the web worker pulled
// from the verified JWT (`userId`, `userName`, `username`); we trust those
// AFTER the signature verifies, and mirror them into editor.users so
// /v1/users/search can resolve @-mention suggestions.
//
// On success, downstream handlers find `c.var.user`, `c.var.db`, and the
// parsed `c.var.body` populated.

import type { Context, MiddlewareHandler } from 'hono';
import { verifyRequest } from '../lib/hmac';
import { makeDb, type Sql } from '../lib/db';
import { upsertUserImpl } from '../handlers/docs';
import type { AppBindings, AuthedUser } from '../context';

/* v8 ignore next 1 — default-factory closure exercised end-to-end at deploy. */
const defaultDbFactory = (c: Context<AppBindings>): Sql => makeDb(c.env);

export function hmacMiddleware(
  dbFactory: (c: Context<AppBindings>) => Sql = defaultDbFactory,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const timestampHeader = c.req.header('X-Timestamp');
    const signature = c.req.header('X-Signature');

    if (!timestampHeader || !signature) {
      return c.json({ error: 'missing auth headers' }, 401);
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      return c.json({ error: 'invalid timestamp' }, 401);
    }

    const raw = await c.req.raw.text();
    const ok = await verifyRequest(c.env.EDITOR_HMAC_SECRET, raw, timestamp, signature);
    if (!ok) {
      return c.json({ error: 'bad signature' }, 401);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    const userId = typeof parsed.userId === 'string' ? parsed.userId : '';
    if (!userId) {
      return c.json({ error: 'missing userId' }, 401);
    }
    const user: AuthedUser = {
      userId,
      userName: typeof parsed.userName === 'string' ? parsed.userName : '',
      username: typeof parsed.username === 'string' ? parsed.username : null,
      // Per-user identity for notifications; fall back to userId when the web
      // worker didn't forward an SSO email (keeps the column always populated).
      email: typeof parsed.email === 'string' && parsed.email ? parsed.email : userId,
    };

    const db = dbFactory(c);
    // Keep the directory mirror current so mention search can find this user.
    await upsertUserImpl(db, user);

    c.set('user', user);
    c.set('db', db);
    c.set('body', parsed);

    await next();
    return undefined;
  };
}
