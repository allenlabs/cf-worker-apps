// Unit tests for the editor-web AI-settings host helpers — they sign + POST to
// the HMAC-gated editor-api /v1/ai/settings/{get,set} routes, forwarding the
// user identity. A fake fetcher is injected; no real network is involved. The
// set helper must forward the (write-only) apiKey; the get helper returns the
// non-secret view (the key is never returned by the API).

import { describe, it, expect, vi } from 'vitest';
import { aiSettingsGetImpl, aiSettingsSetImpl } from '~/server/docs';
import type { CurrentUser } from '~/server/auth-runtime.server';

const ENV = { EDITOR_API_URL: 'https://editor-api.test', EDITOR_HMAC_SECRET: 'shh' };
const USER: CurrentUser = {
  id: 'u-1',
  name: 'Alex',
  username: 'alex',
  email: 'alex@example.com',
} as CurrentUser;
const WS = '11111111-1111-1111-1111-111111111111';

describe('aiSettingsGetImpl', () => {
  it('posts the workspace id and returns the non-secret view', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({ provider: 'openai', baseUrl: 'https://x/v1', hasKey: true, canManage: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const out = await aiSettingsGetImpl(ENV, USER, WS, {
      fetcher: fetcher as unknown as typeof fetch,
      now: () => 1,
    });
    expect(out).toEqual({ provider: 'openai', baseUrl: 'https://x/v1', hasKey: true, canManage: true });
    expect(captured!.url).toBe('https://editor-api.test/v1/ai/settings/get');
    expect(captured!.body).toMatchObject({ userId: 'u-1', workspaceId: WS });
    // The view never carries a key field.
    expect(JSON.stringify(out)).not.toContain('apiKey');
  });
});

describe('aiSettingsSetImpl', () => {
  it('forwards provider/baseUrl/model + the write-only apiKey to /set', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({ provider: 'openai', baseUrl: 'https://x/v1', model: 'm', hasKey: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const out = await aiSettingsSetImpl(
      ENV,
      USER,
      { workspaceId: WS, provider: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-secret' },
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(out).toEqual({ provider: 'openai', baseUrl: 'https://x/v1', model: 'm', hasKey: true });
    expect(captured!.url).toBe('https://editor-api.test/v1/ai/settings/set');
    expect(captured!.body).toMatchObject({
      userId: 'u-1',
      workspaceId: WS,
      provider: 'openai',
      apiKey: 'sk-secret',
    });
  });

  it('propagates a forbidden (403) from the API for non-admins', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    await expect(
      aiSettingsSetImpl(
        ENV,
        USER,
        { workspaceId: WS, provider: 'workers_ai' },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/403/);
  });
});
