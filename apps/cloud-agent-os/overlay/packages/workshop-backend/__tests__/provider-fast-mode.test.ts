import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiModelConfig } from '@gadgets/workshop-shared/api';
import { getModel } from '../src/ai-models';
import { normalizeChatFastMode } from '../src/user';
import { fastModeInfo } from '../src/fast-mode';

const user = { type: 'user' as const, id: 'fast-native@example.invalid', name: 'Synthetic user' };
const direct = { CODEX_BRIDGE_MANAGEMENT: 'admin' } as Cloudflare.Env;
const cases = [
  { provider: 'openai', model: 'gpt-6.1-sol', field: 'service_tier', value: 'priority' },
  { provider: 'anthropic', model: 'claude-opus-5-5', field: 'speed', value: 'fast' },
  { provider: 'google', model: 'gemini-2.5-flash', field: 'serviceTier', value: 'priority' },
] as const;

afterEach(() => vi.unstubAllGlobals());

describe('provider Fast request transport', () => {
  for (const item of cases) it(`serializes ${item.provider} Fast without changing reasoning or later steps`, async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: JSON.parse(await request.text()) });
      return Response.json({ error: { message: 'Synthetic rejected request', type: 'invalid_request_error', status: 'INVALID_ARGUMENT', code: 400 } }, { status: 400 });
    });
    const config: AiModelConfig = { provider: item.provider, model: item.model, apiToken: 'synthetic-key', reasoning: 'high' };
    const routing = { fastMode: true };
    const handle = getModel(direct, config, user, routing);
    routing.fastMode = false;
    for (let index = 0; index < 2; index++) {
      await handle.stream(handle.model, { messages: [{ role: 'user', content: 'Synthetic input', timestamp: 0 }] }, { maxRetries: 0 }).result();
      expect(requests.at(-1)?.body[item.field]).toBe(item.value);
    }
    const optedIn = requests.at(-1)!.body;
    const ordinary = getModel(direct, config, user);
    await ordinary.stream(ordinary.model, { messages: [{ role: 'user', content: 'Synthetic input', timestamp: 0 }] }, { maxRetries: 0 }).result();
    const standard = requests.at(-1)!.body;
    expect(standard).not.toHaveProperty(item.field);
    for (const field of ['reasoning', 'reasoning_effort', 'thinking', 'output_config', 'generationConfig'])
      expect(optedIn[field]).toEqual(standard[field]);
    expect(requests).toHaveLength(3);
  });

  for (const management of ['user', undefined]) it(`keeps legacy bridge ${management ?? 'default'} capability separate from native API support`, async () => {
    const config: AiModelConfig = { provider: 'openai', model: 'gpt-6.1-sol', apiToken: '' };
    let calls = 0;
    const legacy = { CODEX_BRIDGE_MANAGEMENT: management, CODEX_BRIDGE_MODEL: config.model,
      CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([user.id]), CODEX_BRIDGE: {
        async infer() { calls++; throw new Error('Synthetic bridge failure'); },
      } } as unknown as Cloudflare.Env;
    expect(fastModeInfo(config, false, legacy).supportsFast).not.toBe(true);
    expect(() => normalizeChatFastMode({ config, profile: { ...user, type: 'agent', supportsFast: true } }, true, legacy)).toThrow(/Legacy.*account|legacy.*account/);
    expect(() => getModel(legacy, config, user, { fastMode: true })).toThrow(/Legacy.*account|legacy.*account/);
    expect(calls).toBe(0);
    const standard = getModel(legacy, config, user);
    expect((await standard.stream(standard.model, { messages: [] }).result()).stopReason).toBe('error');
    expect(calls).toBe(1);
  });

  it('retains native Priority through both Cloudflare Gateway billing routes', async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: JSON.parse(await request.text()) });
      return Response.json({ error: { message: 'Synthetic rejection', type: 'invalid_request_error' } }, { status: 400 });
    });
    const config: AiModelConfig = { provider: 'openai', model: 'gpt-6.1-sol', apiToken: 'synthetic' };
    const platform = { CF_AI_GATEWAY: 'synthetic', CF_AI_GATEWAY_ACCOUNT_ID: 'fixture-account',
      CF_AI_GATEWAY_API_TOKEN: 'synthetic', CF_AI_GATEWAY_PROVIDERS: 'openai' } as Cloudflare.Env;
    for (const routing of [{ fastMode: true }, { fastMode: true, userGateway: { accountId: 'fixture-personal', apiKey: 'synthetic' } }]) {
      const handle = getModel(platform, config, user, routing);
      await handle.stream(handle.model, { messages: [{ role: 'user', content: 'Synthetic', timestamp: 0 }] }, { maxRetries: 0 }).result();
      expect(requests.at(-1)?.body.service_tier).toBe('priority');
      expect(requests.at(-1)?.url).toContain('gateway.ai.cloudflare.com/');
    }
    expect(requests).toHaveLength(2);
  });

  it('derives native support from physical config instead of forged author metadata', () => {
    for (const item of cases) {
      const config = { provider: item.provider, model: item.model, apiToken: 'synthetic-key' };
      expect(normalizeChatFastMode({ config, profile: { type: 'agent', id: 'personal', name: 'Synthetic', supportsFast: false } }, true)).toBe(true);
      expect(() => normalizeChatFastMode({ config: { ...config, apiUrl: 'https://proxy.example.invalid' },
        profile: { type: 'agent', id: 'forged', name: 'Synthetic', supportsFast: true } }, true)).toThrow(/Fast.*not available/);
    }
  });

  it('keeps exact endpoint, snapshot, model and subscription restrictions independent', () => {
    const base: AiModelConfig = { provider: 'openai', model: 'gpt-6.1-sol', apiToken: '' };
    expect(fastModeInfo({ ...base, apiUrl: 'https://api.openai.com/v1/' }).supportsFast).toBe(true);
    for (const apiUrl of ['https://api.openai.com.evil.invalid/v1', 'https://api.openai.com/v1/responses', 'https://user@api.openai.com/v1'])
      expect(fastModeInfo({ ...base, apiUrl }).supportsFast).not.toBe(true);
    expect(fastModeInfo({ ...base, model: 'gpt-6.1-sol-future-snapshot' }).supportsFast).not.toBe(true);
    expect(fastModeInfo({ ...base, transport: 'scoped', scopedProviderId: 'synthetic' }).supportsFast).not.toBe(true);
    expect(fastModeInfo({ ...base, transport: 'subscription', subscriptionProvider: 'siwc' }).supportsFast).not.toBe(true);
    expect(fastModeInfo({ ...base, transport: 'subscription', subscriptionProvider: 'siwc' }, true).supportsFast).toBe(true);
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
      expect(fastModeInfo({ ...base, model, transport: 'subscription', subscriptionProvider: 'codex' }).supportsFast).toBe(true);
    expect(fastModeInfo({ ...base, model: 'gpt-5.5', transport: 'subscription', subscriptionProvider: 'codex' }).supportsFast).not.toBe(true);
  });

  it('rejects unknown models, preview Anthropic entitlement, and generic endpoints before inference', () => {
    const configs: AiModelConfig[] = [
      { provider: 'openai', model: 'future-unknown', apiToken: '' },
      { provider: 'openai', model: 'gpt-6.1-sol', apiToken: '', apiUrl: 'https://proxy.example.invalid/v1' },
      { provider: 'anthropic', model: 'claude-opus-4-6', apiToken: '' },
      { provider: 'anthropic', model: 'claude-opus-5', apiToken: '' },
      { provider: 'google', model: 'gemini-2.5-flash-image', apiToken: '' },
      { provider: 'ollama', model: 'gpt-6.1-sol', apiToken: '' },
      { provider: 'cloudflare', model: '@cf/meta/llama', apiToken: '', accountId: 'synthetic' },
    ];
    for (const config of configs) expect(() => getModel(direct, config, user, { fastMode: true })).toThrow(/Fast.*not available/);
  });
});
