// HMAC middleware.
//
// Every API request must carry:
//   X-Client-Id   — the `app_clients.client_id` (e.g. 'pm')
//   X-Timestamp   — request issue time as ms-since-epoch (number)
//   X-Signature   — base64 HMAC-SHA256(`${timestamp}\n${body}`, shared-secret)
//
// On success this middleware:
//   1. Loads the `app_clients` row.
//   2. Reads + buffers the raw body once (downstream handlers parse from
//      `c.var.rawBody` so we don't double-consume the stream).
//   3. Verifies the signature + timestamp skew.
//   4. Stashes the client + DB on `c.var.*`.
//
// On failure it 401s with a small JSON error body.

import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { verifyRequest } from '@shared/crypto';
import { makeDb } from '@shared/db/client';
import { appClients } from '@shared/db/schema';
import type { DB } from '@shared/db/client';
import type { AppBindings, AppClientContext } from '../context';

/**
 * Factory variant — accepts an explicit DB factory so tests can inject
 * a PGlite-backed connection without spinning Hyperdrive up.
 */
/* v8 ignore next 3 — default-factory closure is exercised by the deployed
   worker; tests inject an explicit dbFactory to avoid Hyperdrive. */
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
    const row = await db.query.appClients.findFirst({
      where: eq(appClients.clientId, clientId),
    });
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
      hmacSecret: row.hmacSecret,
      allowedReturnOrigins: row.allowedReturnOrigins,
    };
    c.set('appClient', appClient);
    c.set('db', db);
    c.set('rawBody', body);

    await next();
    return undefined;
  };
}
