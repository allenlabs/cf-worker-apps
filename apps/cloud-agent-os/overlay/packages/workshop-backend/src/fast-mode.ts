import type { AiModelConfig } from '@gadgets/workshop-shared/api';

const openai = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-mini', 'o3', 'o4-mini', 'gpt-5.3-codex']);
const codex = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
const google = new Set(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
const endpoints = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', google: 'https://generativelanguage.googleapis.com/v1beta' };
export type FastRequest = 'openai' | 'anthropic' | 'google';
export type FastModeInfo = { supportsFast?: true; fastModeDescription: string };
export type FastModeEnvironment = Partial<Cloudflare.Env> & { CODEX_BRIDGE?: unknown; CODEX_BRIDGE_MANAGEMENT?: string };
const unavailable = (reason: string): FastModeInfo => ({ fastModeDescription: `Fast is not available. ${reason}` });

/** Request-tier support, separate from reasoning and from an account's current entitlement. */
export function fastModeInfo(config: AiModelConfig, siwcFast = false, env: FastModeEnvironment = {}): FastModeInfo {
  if (config.transport === 'scoped') return unavailable('This compatible connection has no verified Fast adapter.');
  if (config.transport === 'subscription') {
    if (config.subscriptionProvider === 'siwc') return siwcFast
      ? { supportsFast: true, fastModeDescription: 'Priority may use more allowance or credits. Availability and delivered speed depend on this SIWC account.' }
      : unavailable('This SIWC account does not advertise Fast for this model. Refresh its model catalog.');
    if (config.subscriptionProvider === 'codex' && codex.has(config.model)) return {
      supportsFast: true, fastModeDescription: 'Codex Fast uses 2.5× included allowance or 2× purchased credits/PAYG. Account entitlement is unverified; your plan or administrator must allow Fast.' };
    return unavailable('This subscription connection has no verified Fast support for this model.');
  }
  if (env.CODEX_BRIDGE && env.CODEX_BRIDGE_MANAGEMENT !== 'admin')
    return unavailable('Legacy subscription bridges do not verify account-specific Fast support. Use an admin-managed subscription connection.');
  if (config.provider === 'cloudflare') return unavailable('Workers AI does not expose a documented Fast processing tier.');
  if (config.provider === 'ollama') return unavailable('Ollama does not expose a documented Fast processing tier.');
  if (config.apiUrl !== undefined && config.apiUrl.replace(/\/+$/, '') !== endpoints[config.provider])
    return unavailable('Custom endpoints require a verified provider Fast adapter.');
  if (config.provider === 'openai' && openai.has(config.model)) return { supportsFast: true,
    fastModeDescription: 'OpenAI Priority has premium per-token prices and requires eligible API access. GPT-5.4/5.5 require context below 272K tokens. Delivered speed is provider-dependent.' };
  if (config.provider === 'anthropic' && config.model === 'claude-opus-5-5') return { supportsFast: true,
    fastModeDescription: 'Anthropic Fast has premium per-token prices and requires Start, Build or Scale API access. Account entitlement is unverified.' };
  if (config.provider === 'anthropic' && ['claude-opus-5', 'claude-opus-4-8'].includes(config.model))
    return unavailable('This preview requires separate Anthropic Fast access and a beta adapter.');
  if (config.provider === 'google' && google.has(config.model)) return { supportsFast: true,
    fastModeDescription: 'Gemini Priority costs 75–100% more and requires paid Tier 2 or 3 access. Account entitlement is unverified; overflow may use Standard.' };
  return unavailable('The provider does not document Fast support for this model.');
}

export function nativeFastRequest(config: AiModelConfig, env: FastModeEnvironment = {}): FastRequest | undefined {
  return config.transport === undefined && fastModeInfo(config, false, env).supportsFast ? config.provider as FastRequest : undefined;
}

export function fastPayload(kind: FastRequest, payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('Invalid Fast request payload.');
  if (kind === 'google') {
    const params = payload as { config?: object };
    return { ...params, config: { ...params.config, serviceTier: 'priority' } };
  }
  return { ...payload, ...(kind === 'anthropic' ? { speed: 'fast' } : { service_tier: 'priority' }) };
}
