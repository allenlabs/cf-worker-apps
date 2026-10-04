import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildHeaders,
  joinUrl,
  pingHealth,
  signBody,
  signedFetch,
} from '../src/lib/hmac.js';

describe('signBody', () => {
  it('matches a hand-computed HMAC', () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ text: 'hi' });
    const expected = createHmac('sha256', 's').update(`${ts}\n${body}`).digest('base64');
    expect(signBody('s', body, ts)).toBe(expected);
  });
});

describe('buildHeaders', () => {
  it('uses Date.now() when no timestamp passed', () => {
    const headers = buildHeaders('cli', 's', '');
    expect(headers['X-Client-Id']).toBe('cli');
    expect(Number(headers['X-Timestamp'])).toBeGreaterThan(0);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Signature'].length).toBeGreaterThan(0);
  });
  it('uses the provided timestamp when given', () => {
    const headers = buildHeaders('cli', 's', 'body', 12345);
    expect(headers['X-Timestamp']).toBe('12345');
    expect(headers['X-Signature']).toBe(signBody('s', 'body', 12345));
  });
});

describe('joinUrl', () => {
  it('handles base with trailing slash', () => {
    expect(joinUrl('https://x/', '/path')).toBe('https://x/path');
  });
  it('handles path without leading slash', () => {
    expect(joinUrl('https://x', 'path')).toBe('https://x/path');
  });
  it('handles plain join', () => {
    expect(joinUrl('https://x', '/path')).toBe('https://x/path');
  });
});

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as typeof fetch;
}

const ENDPOINT = { url: 'https://api.test', client_id: 'cli', secret: 's' };

describe('signedFetch', () => {
  it('signs the body and parses a JSON success payload', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = mockFetch(async (input, init) => {
      capturedUrl = input as string;
      capturedInit = init;
      return new Response(JSON.stringify({ id: 42, capturedAt: '2026-05-24T00:00:00Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const result = await signedFetch<{ id: number }>(ENDPOINT, '/v1/capture', {
      method: 'POST',
      body: { text: 'hi' },
      now: 1_700_000_000_000,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe(42);
    expect(capturedUrl).toBe('https://api.test/v1/capture');
    expect(capturedInit?.method).toBe('POST');
    const h = capturedInit?.headers as Record<string, string>;
    expect(h['X-Client-Id']).toBe('cli');
    expect(h['X-Timestamp']).toBe('1700000000000');
    expect(capturedInit?.body).toBe(JSON.stringify({ text: 'hi' }));
  });

  it('returns the API error string on 4xx with JSON body', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 }),
    );
    const result = await signedFetch(ENDPOINT, '/v1/x', { body: {}, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('bad signature');
  });

  it('returns the raw body when JSON error body lacks an `error` string', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 500 }),
    );
    const result = await signedFetch(ENDPOINT, '/v1/x', { body: {}, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('{"wrong":"shape"}');
  });

  it('handles non-JSON success bodies by stashing text in data', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response('plain ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const result = await signedFetch<string>(ENDPOINT, '/v1/x', { method: 'GET', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.data).toBe('plain ok');
  });

  it('handles non-JSON error bodies', async () => {
    const fetchImpl = mockFetch(async () => new Response('boom', { status: 502 }));
    const result = await signedFetch(ENDPOINT, '/v1/x', { method: 'GET', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('handles empty body on error', async () => {
    const fetchImpl = mockFetch(async () => new Response('', { status: 503 }));
    const result = await signedFetch(ENDPOINT, '/v1/x', { method: 'GET', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503');
  });

  it('handles empty body on success', async () => {
    // 204/205 disallow bodies entirely; use 200 with an empty string instead.
    const fetchImpl = mockFetch(async () => new Response('', { status: 200 }));
    const result = await signedFetch(ENDPOINT, '/v1/x', { method: 'POST', body: {}, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it('catches network errors', async () => {
    const fetchImpl = mockFetch(async () => { throw new Error('econnrefused'); });
    const result = await signedFetch(ENDPOINT, '/v1/x', { body: {}, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe('econnrefused');
  });

  it('catches non-Error throws', async () => {
    const fetchImpl = mockFetch(async () => { throw 'string-thrown'; });
    const result = await signedFetch(ENDPOINT, '/v1/x', { body: {}, fetchImpl });
    expect(result.error).toBe('string-thrown');
  });

  it('does not send a body on GET', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mockFetch(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    });
    await signedFetch(ENDPOINT, '/v1/x', { method: 'GET', fetchImpl });
    expect(capturedInit?.body).toBeUndefined();
  });

  it('aborts on timeout', async () => {
    const fetchImpl = mockFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = await signedFetch(ENDPOINT, '/v1/x', {
      body: {},
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('aborted');
  });

  it('falls back to global fetch + defaults when called minimally', async () => {
    const originalFetch = globalThis.fetch;
    let captured: { method?: string; body?: unknown } | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { method: init?.method, body: init?.body };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await signedFetch(ENDPOINT, '/v1/x');
      expect(r.ok).toBe(true);
      // No body passed → bodyStr = '' → no init.body on the request.
      expect(captured?.method).toBe('POST');
      expect(captured?.body).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('pingHealth', () => {
  it('returns ok on 200', async () => {
    const fetchImpl = mockFetch(async () => new Response('ok', { status: 200 }));
    const r = await pingHealth('https://x', { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
  });
  it('falls back to global fetch when no fetchImpl is passed', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const r = await pingHealth('https://x');
      expect(called).toBe(true);
      expect(r.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('returns error on 5xx', async () => {
    const fetchImpl = mockFetch(async () => new Response('', { status: 502 }));
    const r = await pingHealth('https://x', { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 502');
  });
  it('catches network errors', async () => {
    const fetchImpl = mockFetch(async () => { throw new Error('dns'); });
    const r = await pingHealth('https://x', { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBe('dns');
  });
  it('catches non-Error throws', async () => {
    const fetchImpl = mockFetch(async () => { throw 'plain'; });
    const r = await pingHealth('https://x', { fetchImpl });
    expect(r.error).toBe('plain');
  });
  it('aborts on timeout', async () => {
    const fetchImpl = mockFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const r = await pingHealth('https://x', { fetchImpl, timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
  });
});
