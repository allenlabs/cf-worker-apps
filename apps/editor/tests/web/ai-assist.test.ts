// Unit test for the editor-web `aiAssistImpl` host helper — the implementation
// of the editor's `askAI` hook. It must sign + POST the action input (plus the
// user identity) to the HMAC-gated editor-api `/v1/ai` route. A fake fetcher is
// injected; no real network / LLM is involved.

import { describe, it, expect, vi } from 'vitest';
import { aiAssistImpl } from '~/server/docs';
import type { CurrentUser } from '~/server/auth-runtime.server';

const ENV = { EDITOR_API_URL: 'https://editor-api.test', EDITOR_HMAC_SECRET: 'shh' };
const USER: CurrentUser = {
  id: 'u-1',
  name: 'Alex',
  username: 'alex',
  email: 'alex@example.com',
} as CurrentUser;

describe('aiAssistImpl (host askAI implementation)', () => {
  it('signs + posts the action input and user identity to /v1/ai, returns text', async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      };
      return new Response(JSON.stringify({ text: 'AI says hi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const out = await aiAssistImpl(
      ENV,
      USER,
      { action: 'translate', text: '안녕', targetLang: 'English' },
      { fetcher: fetcher as unknown as typeof fetch, now: () => 1234 },
    );

    expect(out).toEqual({ text: 'AI says hi' });
    expect(captured!.url).toBe('https://editor-api.test/v1/ai');
    expect(captured!.headers['X-Timestamp']).toBe('1234');
    expect(captured!.headers['X-Signature']).toBeTruthy();
    expect(captured!.body).toMatchObject({
      userId: 'u-1',
      action: 'translate',
      text: '안녕',
      targetLang: 'English',
    });
  });

  it('propagates an editor-api error (e.g. unconfigured 503)', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: 'AI not configured' }), { status: 503 }),
    );
    await expect(
      aiAssistImpl(
        ENV,
        USER,
        { action: 'summarize', text: 'x' },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/503/);
  });
});
