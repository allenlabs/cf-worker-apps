/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(async () => {
  await reset();
});

describe('url-shortener http', () => {
  it('GET / returns the HTML form', async () => {
    const res = await SELF.fetch('http://x.test/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('URL Shortener');
  });

  it('POST /api/shorten + GET /:code redirects', async () => {
    const create = await SELF.fetch('http://x.test/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', code: 'helo' }),
    });
    expect(create.status).toBe(201);

    const r = await SELF.fetch('http://x.test/helo', { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com');
  });

  it('GET /api/links/:code returns the stored record', async () => {
    await SELF.fetch('http://x.test/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', code: 'meta' }),
    });
    const info = await SELF.fetch('http://x.test/api/links/meta');
    const body = (await info.json()) as { url: string; clicks: number };
    expect(body.url).toBe('https://example.com');
    expect(body.clicks).toBe(0);
  });

  it('returns 404 for unknown codes', async () => {
    const r = await SELF.fetch('http://x.test/ghost', { redirect: 'manual' });
    expect(r.status).toBe(404);
  });

  it('rejects malformed JSON body with 400', async () => {
    const r = await SELF.fetch('http://x.test/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 for invalid URL', async () => {
    const r = await SELF.fetch('http://x.test/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(r.status).toBe(400);
  });
});
