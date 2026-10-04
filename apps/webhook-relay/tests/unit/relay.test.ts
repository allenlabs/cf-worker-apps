import { describe, expect, it, vi } from 'vitest';
import { deliverOnce } from '../../workers/relay/delivery';
import type { Subscriber, WebhookEvent } from '../../shared/types';

const event: WebhookEvent = {
  id: 'evt-1',
  source: 'github',
  method: 'POST',
  path: '/hooks/github',
  headers: { 'content-type': 'application/json' },
  bodyBase64: btoa('{"hello":"world"}'),
  receivedAt: Date.now(),
};

const subscriber: Subscriber = {
  id: 'sub-1',
  endpoint: 'https://example.com/hook',
  headerName: 'X-Token',
  headerValue: 'shh',
};

describe('deliverOnce', () => {
  it('posts the body and reports ok on 2xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const r = await deliverOnce(event, subscriber, 1, 'test-ua', fetcher as any);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://example.com/hook');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['user-agent']).toBe('test-ua');
    expect(headers['x-token']).toBe('shh');
    expect(headers['x-relay-attempt']).toBe('1');
  });

  it('flags non-2xx as not-ok', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const r = await deliverOnce(event, subscriber, 2, 'test-ua', fetcher as any);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('captures network errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await deliverOnce(event, subscriber, 3, 'test-ua', fetcher as any);
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toBe('boom');
  });

  it('omits the custom header when subscriber has none', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const sub2: Subscriber = { id: 'sub-2', endpoint: 'https://example.com/h' };
    await deliverOnce(event, sub2, 1, 'ua', fetcher as any);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init.headers as object)).not.toContain('x-token');
  });

  it('falls back to POST when event.method is empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await deliverOnce({ ...event, method: '' }, subscriber, 1, 'ua', fetcher as any);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });
});
