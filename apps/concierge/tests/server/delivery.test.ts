import { describe, expect, it } from 'vitest';
import { deliverPushImpl } from '~/server/delivery';
import { verifyRequest } from '~/lib/hmac';

function makeFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return await handler(req);
  }) as typeof fetch;
}

describe('deliverPushImpl', () => {
  it('skips when not configured', async () => {
    const result = await deliverPushImpl({}, {
      userId: 1,
      title: 't',
      body: 'b',
      url: 'https://x',
    });
    expect(result).toEqual({ delivered: false, skipped: 'not-configured' });
  });

  it('skips when INBOX_HMAC_SECRET is missing', async () => {
    const result = await deliverPushImpl(
      { INBOX_API_URL: 'https://inbox', INBOX_HMAC_CLIENT_ID: 'c' },
      { userId: 1, title: 't', body: 'b', url: 'https://x' },
    );
    expect(result.skipped).toBe('not-configured');
  });

  it('POSTs an HMAC-signed payload and reports delivered=true on 2xx', async () => {
    const secret = 'shared-secret';
    let seenSig = '';
    let seenBody = '';
    let seenUrl = '';
    let seenClientId = '';
    const fetchFn = makeFetch(async (req) => {
      seenUrl = req.url;
      seenClientId = req.headers.get('X-Client-Id') ?? '';
      seenSig = req.headers.get('X-Signature') ?? '';
      seenBody = await req.text();
      const ts = Number(req.headers.get('X-Timestamp') ?? '0');
      // Verify the signature on the way in — exactly the inbox-api shape.
      const ok = await verifyRequest(secret, seenBody, ts, seenSig);
      return new Response(ok ? 'ok' : 'bad', { status: ok ? 200 : 401 });
    });
    const result = await deliverPushImpl(
      {
        INBOX_API_URL: 'https://inbox-api.test',
        INBOX_HMAC_CLIENT_ID: 'concierge',
        INBOX_HMAC_SECRET: secret,
      },
      { userId: 7, title: 'A nudge', body: 'q', url: 'https://today/' },
      fetchFn,
    );
    expect(result.delivered).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(seenUrl).toBe('https://inbox-api.test/v1/notify');
    expect(seenClientId).toBe('concierge');
    const parsed = JSON.parse(seenBody) as { userId: number; tag: string };
    expect(parsed.userId).toBe(7);
    expect(parsed.tag).toBe('concierge-nudge');
  });

  it('strips a trailing slash on INBOX_API_URL', async () => {
    let seenUrl = '';
    const fetchFn = makeFetch(async (req) => {
      seenUrl = req.url;
      return new Response('', { status: 200 });
    });
    await deliverPushImpl(
      {
        INBOX_API_URL: 'https://inbox-api.test/',
        INBOX_HMAC_CLIENT_ID: 'c',
        INBOX_HMAC_SECRET: 's',
      },
      { userId: 1, title: 't', body: 'b', url: 'https://x', tag: 'custom-tag' },
      fetchFn,
    );
    expect(seenUrl).toBe('https://inbox-api.test/v1/notify');
  });

  it('reports delivered=false on a non-2xx', async () => {
    const fetchFn = makeFetch(() => new Response('nope', { status: 500 }));
    const result = await deliverPushImpl(
      {
        INBOX_API_URL: 'https://inbox-api.test',
        INBOX_HMAC_CLIENT_ID: 'c',
        INBOX_HMAC_SECRET: 's',
      },
      { userId: 1, title: 't', body: 'b', url: 'https://x' },
      fetchFn,
    );
    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(500);
  });
});
