// HMAC middleware for the solved API worker.

import type { Context, MiddlewareHandler } from 'hono';
import { verifyRequest } from '../../../web/app/lib/hmac';
import { findApiClientImpl } from '../../../web/app/server/solved';
import { makeDb } from '../lib/db';
import type { DB } from '../../../web/app/db/client';
import type { AppBindings, AppClientContext } from '../context';

/* v8 ignore next 1 — default-factory closure exercised end-to-end at deploy. */
const defaultDbFactory = (c: Context<AppBindings>): DB => makeDb(c.env);

export function hmacMiddleware(
  dbFactory: (c: Context<AppBindings>) => DB = defaultDbFactory,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const clientId = c.req.header('X-Client-Id');
    const timestampHeader = c.req.header('X-Timestamp');
    const signature = c.req.header('X-Signature');

    if (!clientId || !timestampHeader || !signature) {
      return c.json({ error: 'missing auth headers' }, 401);
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      return c.json({ error: 'invalid timestamp' }, 401);
    }

    const body = await c.req.raw.text();
    const db = dbFactory(c);
    const row = await findApiClientImpl(db, clientId);
    if (!row) {
      return c.json({ error: 'unknown client' }, 401);
    }

    const ok = await verifyRequest(row.hmacSecret, body, timestamp, signature);
    if (!ok) {
      return c.json({ error: 'bad signature' }, 401);
    }

    const appClient: AppClientContext = {
      id: row.id,
      clientId: row.clientId,
      name: row.name,
      userId: row.userId,
    };
    c.set('apiClient', appClient);
    c.set('db', db);
    c.set('rawBody', body);

    await next();
    return undefined;
  };
}
