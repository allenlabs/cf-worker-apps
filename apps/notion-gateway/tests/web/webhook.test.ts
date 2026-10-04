import { describe, expect, it } from 'vitest';
import {
  handleWebhookImpl,
  listWebhookAdminImpl,
  updateWebhookUrlImpl,
} from '../../workers/web/app/server/webhook';
import { webhookSubscriptions } from '@shared/db/schema';
import {
  insertAppClient,
  insertConnection,
  insertWorkspace,
  makeTestDb,
  type TestDB,
} from '../_setup/db';
import { pageLinks } from '@shared/db/schema';

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return hex(new Uint8Array(sig));
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    workspace_id: 'ws-uuid',
    type: 'page.updated',
    entity: { id: 'page-abc', type: 'page' },
    data: {
      properties: {
        Title: { type: 'title', title: [{ plain_text: 'Hello' }] },
        Due: { type: 'date', date: { start: '2026-06-01' } },
      },
    },
    ...overrides,
  };
}

async function seedLinkedPage(db: TestDB, opts: { webhookUrl?: string | null } = {}) {
  const client = await insertAppClient(db, {
    clientId: 'pm',
    hmacSecret: 'shared-secret',
    webhookUrl: opts.webhookUrl === undefined ? 'https://app.example/cb' : opts.webhookUrl,
  });
  const workspace = await insertWorkspace(db);
  const conn = await insertConnection(db, {
    appClientId: client.id,
    workspaceId: workspace.id,
    appResource: 'project/1',
    mapping: {
      fields: {
        subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
        dueDate: { propertyId: 'B', propertyName: 'Due', propertyType: 'date' },
      },
    },
  });
  await db.insert(pageLinks).values({
    connectionId: conn.id,
    appRecord: 'issue/42',
    pageId: 'page-abc',
  });
  return { client, workspace, conn };
}

describe('handleWebhookImpl — verification handshake', () => {
  it('persists a pending row when verification_token arrives without a signature', async () => {
    const db = await makeTestDb();
    const out = await handleWebhookImpl(db, {
      rawBody: JSON.stringify({ verification_token: 'tok-abc' }),
      signatureHeader: null,
    });
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(false);
    const rows = await db.select().from(webhookSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verificationToken).toBe('tok-abc');
    expect(rows[0]!.status).toBe('pending');
  });

  it('rejects malformed JSON with 400', async () => {
    const db = await makeTestDb();
    const out = await handleWebhookImpl(db, {
      rawBody: 'not json',
      signatureHeader: null,
    });
    expect(out.status).toBe(400);
  });

  it('rejects an unsigned non-verification body with 401', async () => {
    const db = await makeTestDb();
    const out = await handleWebhookImpl(db, {
      rawBody: JSON.stringify({ id: 'x' }),
      signatureHeader: null,
    });
    expect(out.status).toBe(401);
  });

  it('accepts a verification handshake whose signature HMACs with the carried token', async () => {
    const db = await makeTestDb();
    const token = 'secret_handshake-token';
    const body = JSON.stringify({ verification_token: token });
    const sig = await hmacSha256Hex(token, body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(false);
    const rows = await db.select().from(webhookSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verificationToken).toBe(token);
  });

  it('rejects a verification handshake whose signature does not HMAC the carried token', async () => {
    const db = await makeTestDb();
    const body = JSON.stringify({ verification_token: 'real-token' });
    const sig = await hmacSha256Hex('different-token', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error).toBe('bad verification signature');
    const rows = await db.select().from(webhookSubscriptions);
    expect(rows).toHaveLength(0);
  });

  it('rejects a verification handshake whose signature header is not sha256= scheme', async () => {
    const db = await makeTestDb();
    const body = JSON.stringify({ verification_token: 'tok' });
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: 'md5=deadbeef',
    });
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error).toBe('bad signature scheme');
  });
});

describe('handleWebhookImpl — signature verification', () => {
  it('200s + fans out on a valid signature, transitioning pending -> verified', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent());
    const sig = await hmacSha256Hex('tok-A', body);
    const fetches: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = ((u: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({ url: String(u), init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    const out = await handleWebhookImpl(
      db,
      { rawBody: body, signatureHeader: `sha256=${sig}` },
      { fetcher },
    );
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(true);
    expect(out.fanout).toBeDefined();
    await out.fanout!();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe('https://app.example/cb');
    const headers = fetches[0]!.init?.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toBe('gateway');
    expect(typeof headers['X-Timestamp']).toBe('string');
    expect(typeof headers['X-Signature']).toBe('string');
    const payload = JSON.parse(String(fetches[0]!.init?.body));
    expect(payload.event).toBe('page.updated');
    expect(payload.app_resource).toBe('project/1');
    expect(payload.app_record).toBe('issue/42');
    expect(payload.notion_page_id).toBe('page-abc');
    expect(payload.notion_event_id).toBe('evt-1');
    expect(payload.fields).toEqual({ subject: 'Hello', dueDate: '2026-06-01' });

    // pending -> verified
    const subs = await db.select().from(webhookSubscriptions);
    expect(subs[0]!.status).toBe('verified');
    expect(subs[0]!.verifiedAt).not.toBeNull();
  });

  it('401s on a bad signature, with no fanout', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent());
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: 'sha256=deadbeef',
    });
    expect(out.status).toBe(401);
    expect(out.fanned).toBe(false);
  });

  it('rejects a signature scheme other than sha256', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const out = await handleWebhookImpl(db, {
      rawBody: JSON.stringify(makeEvent()),
      signatureHeader: 'md5=abc',
    });
    expect(out.status).toBe(401);
  });

  it('treats a signature header without "=" as a raw hex (mismatch -> 401)', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const out = await handleWebhookImpl(db, {
      rawBody: JSON.stringify(makeEvent()),
      signatureHeader: 'badrawhex',
    });
    expect(out.status).toBe(401);
  });

  it('treats a signature header without "=" as a raw hex (match -> verifies)', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent());
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: sig, // no scheme prefix at all
    });
    // No fanout (no linked page in this DB) but signature matched -> 200.
    expect(out.status).toBe(200);
  });

  it('tries multiple pending tokens until one verifies', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'wrong-1' });
    await db.insert(webhookSubscriptions).values({ verificationToken: 'wrong-2' });
    await db.insert(webhookSubscriptions).values({ verificationToken: 'right-3' });
    const body = JSON.stringify(makeEvent());
    const sig = await hmacSha256Hex('right-3', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    expect(out.verifiedSubscriptionId).toBeDefined();
    // Only the matched row flipped to verified.
    const rows = await db.select().from(webhookSubscriptions).orderBy(webhookSubscriptions.id);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[1]!.status).toBe('pending');
    expect(rows[2]!.status).toBe('verified');
  });

  it('does not re-flip an already-verified token', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({
      verificationToken: 'tok-A',
      status: 'verified',
      verifiedAt: new Date(0),
    });
    const body = JSON.stringify(makeEvent());
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    const rows = await db.select().from(webhookSubscriptions);
    expect(rows[0]!.verifiedAt!.getTime()).toBe(0); // unchanged
  });
});

describe('handleWebhookImpl — event routing', () => {
  it('200s with no fanout when the page_id is unknown', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent({ entity: { id: 'unknown-page', type: 'page' } }));
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(false);
  });

  it('200s with no fanout when webhook_url is null on the app client', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db, { webhookUrl: null });
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent());
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(false);
  });

  it('401s when the event timestamp is older than 5 minutes', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = JSON.stringify(makeEvent({ timestamp: oldTs }));
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(401);
    expect(out.fanned).toBe(false);
  });

  it('401s when the event timestamp is unparseable', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent({ timestamp: 'not-a-date' }));
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(401);
  });

  it('401s when the event timestamp is missing entirely', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify(makeEvent({ timestamp: undefined }));
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(401);
  });

  it('honours an injected deps.now for deterministic replay-window checks', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const eventTs = new Date('2026-01-01T00:00:00Z').toISOString();
    const body = JSON.stringify(makeEvent({ timestamp: eventTs }));
    const sig = await hmacSha256Hex('tok-A', body);
    const fetcher = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
    // now = eventTs + 30s — comfortably inside the 5min window.
    const fakeNow = new Date('2026-01-01T00:00:30Z').getTime();
    const out = await handleWebhookImpl(
      db,
      { rawBody: body, signatureHeader: `sha256=${sig}` },
      { fetcher, now: () => fakeNow },
    );
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(true);
    await out.fanout!();
  });

  it('200s + skip when the payload lacks an entity', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const body = JSON.stringify({
      id: 'evt-no-entity',
      timestamp: new Date().toISOString(),
      type: 'unknown',
    });
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(db, {
      rawBody: body,
      signatureHeader: `sha256=${sig}`,
    });
    expect(out.status).toBe(200);
    expect(out.fanned).toBe(false);
  });

  it('handles a payload whose data.properties block is absent', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const fetches: Array<{ body?: unknown }> = [];
    const fetcher = ((_: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({ body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    const body = JSON.stringify(makeEvent({ data: { something_else: true } }));
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(
      db,
      { rawBody: body, signatureHeader: `sha256=${sig}` },
      { fetcher },
    );
    expect(out.status).toBe(200);
    await out.fanout!();
    expect((fetches[0]!.body as { fields: Record<string, unknown> }).fields).toEqual({});
  });

  it('handles a payload with no data block at all', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const fetcher = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
    const body = JSON.stringify({
      id: 'evt-2',
      timestamp: new Date().toISOString(),
      type: 'page.deleted',
      entity: { id: 'page-abc', type: 'page' },
    });
    const sig = await hmacSha256Hex('tok-A', body);
    const out = await handleWebhookImpl(
      db,
      { rawBody: body, signatureHeader: `sha256=${sig}` },
      { fetcher },
    );
    expect(out.fanned).toBe(true);
    await out.fanout!();
  });

  it('uses globalThis.fetch when no fetcher is injected', async () => {
    const db = await makeTestDb();
    await seedLinkedPage(db);
    await db.insert(webhookSubscriptions).values({ verificationToken: 'tok-A' });
    const original = globalThis.fetch;
    let called = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const body = JSON.stringify(makeEvent());
      const sig = await hmacSha256Hex('tok-A', body);
      const out = await handleWebhookImpl(db, {
        rawBody: body,
        signatureHeader: `sha256=${sig}`,
      });
      expect(out.fanned).toBe(true);
      await out.fanout!();
      expect(called).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('listWebhookAdminImpl', () => {
  it('returns pending tokens and the verified count', async () => {
    const db = await makeTestDb();
    await db.insert(webhookSubscriptions).values({ verificationToken: 'p1' });
    await db.insert(webhookSubscriptions).values({
      verificationToken: 'v1',
      status: 'verified',
      verifiedAt: new Date(),
    });
    await db.insert(webhookSubscriptions).values({
      verificationToken: 'f1',
      status: 'failed',
    });
    const out = await listWebhookAdminImpl(db);
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.verificationToken).toBe('p1');
    expect(out.verifiedCount).toBe(1);
  });
});

describe('updateWebhookUrlImpl', () => {
  it('sets and clears the webhook_url column', async () => {
    const db = await makeTestDb();
    const c = await insertAppClient(db, { clientId: 'pm' });
    await updateWebhookUrlImpl(db, c.id, 'https://app.example/cb');
    const after = await db.query.appClients.findFirst({
      where: (a, { eq }) => eq(a.id, c.id),
    });
    expect(after?.webhookUrl).toBe('https://app.example/cb');

    await updateWebhookUrlImpl(db, c.id, '');
    const cleared = await db.query.appClients.findFirst({
      where: (a, { eq }) => eq(a.id, c.id),
    });
    expect(cleared?.webhookUrl).toBeNull();
  });

  it('treats null the same as an empty string', async () => {
    const db = await makeTestDb();
    const c = await insertAppClient(db, { clientId: 'pm' });
    await updateWebhookUrlImpl(db, c.id, null);
    const after = await db.query.appClients.findFirst({
      where: (a, { eq }) => eq(a.id, c.id),
    });
    expect(after?.webhookUrl).toBeNull();
  });
});
