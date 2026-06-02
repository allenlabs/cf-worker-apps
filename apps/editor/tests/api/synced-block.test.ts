// Phase 12 — synced blocks. Two pure surfaces:
//   - hasAnyMembershipImpl: the gate for minting a `sync-<uuid>` collab token.
//   - mintCollabToken: confirms a synced-block room mints a verifiable token of
//     the documented shape (payloadPart.sigPart, MAC over the b64url payload).

import { describe, it, expect } from 'vitest';
import { hasAnyMembershipImpl } from '@api/handlers/pages';
import { mintCollabToken, base64urlString } from '@api/lib/hmac';
import type { Sql } from '@api/lib/db';

function fakeSql(rows: unknown[]): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

describe('hasAnyMembershipImpl', () => {
  it('is true when the user belongs to at least one workspace', async () => {
    expect(await hasAnyMembershipImpl(fakeSql([{ '?column?': 1 }]), 'u1')).toBe(true);
  });

  it('is false when the user has no workspace membership', async () => {
    expect(await hasAnyMembershipImpl(fakeSql([]), 'u1')).toBe(false);
  });
});

describe('mintCollabToken for a synced-block room', () => {
  const SECRET = 'test-secret';

  it('produces a payloadPart.sig token whose payload round-trips the sync room', async () => {
    const room = 'sync-11111111-2222-4333-8444-555555555555';
    const payload = { room, exp: 9999999999, uid: 'u1', name: 'Alice' };
    const token = await mintCollabToken(SECRET, payload);

    const [payloadPart, sigPart] = token.split('.');
    expect(payloadPart).toBeTruthy();
    expect(sigPart).toBeTruthy();
    // payloadPart is exactly b64url(JSON(payload)).
    expect(payloadPart).toBe(base64urlString(JSON.stringify(payload)));

    // Decode the payload and confirm the room is preserved verbatim.
    const json = Buffer.from(
      payloadPart!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(JSON.parse(json).room).toBe(room);
  });
});
