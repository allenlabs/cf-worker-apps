import { eq } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { apiClients } from '@allenlabs/pm-core/db/schema';

export interface ApiClientRow {
  id: number;
  clientId: string;
  name: string;
  hmacSecret: string;
  userId: number;
}

/** Look up an HMAC API client by its public client_id. */
export async function findApiClientImpl(db: DB, clientId: string): Promise<ApiClientRow | null> {
  const row = await db.query.apiClients.findFirst({
    where: eq(apiClients.clientId, clientId),
  });
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    hmacSecret: row.hmacSecret,
    userId: row.userId,
  };
}

/** Provision a new API client acting on behalf of `userId`. */
export async function createApiClientImpl(
  db: DB,
  data: { clientId: string; name: string; hmacSecret: string; userId: number },
): Promise<ApiClientRow> {
  const [row] = await db
    .insert(apiClients)
    .values({
      clientId: data.clientId,
      name: data.name,
      hmacSecret: data.hmacSecret,
      userId: data.userId,
    })
    .returning();
  /* v8 ignore next */
  if (!row) throw new Error('failed to create api client');
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    hmacSecret: row.hmacSecret,
    userId: row.userId,
  };
}
