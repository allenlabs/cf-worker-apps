// AI assist impl. A pure, dependency-injected function that maps an editor AI
// action to an action-specific system+user prompt, calls an OpenAI-compatible
// `/chat/completions` endpoint via an injected fetcher, and returns `{ text }`.
//
// Mirrors the concierge cron LLM client (plain `fetch`, no SDK). Network stays
// behind the editor-api HMAC gate — the @allenlabs/editor package never calls
// an LLM directly; the host's `askAI` hook routes here through editor-web.
//
// Kept Hono/Cloudflare-free so it's unit-testable with a fake fetcher.

/** Structural subset of the Cloudflare Workers AI binding (`Ai`) that this
 * handler uses. Declaring our own minimal shape (rather than importing the full
 * `Ai` type) keeps `ai.ts` Cloudflare-runtime-free + trivially stubbable in
 * unit tests, while the real `Env.AI: Ai` binding is structurally assignable to
 * it (its `run(model: string & {}, …)` overload returns `Record<string, unknown>`). */
export interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** LLM config for the AI assist route. Two backends, selected in this order:
 *   1. OpenAI-compatible `/chat/completions` — used when BOTH `LLM_BASE_URL`
 *      and `LLM_API_KEY` are set (lets the user point at LiteLLM/OpenAI/etc.).
 *   2. Cloudflare Workers AI (`AI` binding) — the on-edge default; no external
 *      key needed. Model overridable via `WORKERS_AI_MODEL` (or `LLM_MODEL`).
 *   3. Neither → the route returns 503 "AI not configured" (no crash).
 * All fields are OPTIONAL; `AI` is the wrangler `[ai]` binding when present. */
export interface AiEnv {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  /** Optional override for the Workers AI model id (defaults to a llama instruct). */
  WORKERS_AI_MODEL?: string;
  /** Cloudflare Workers AI binding (wrangler `[ai] binding = "AI"`). */
  AI?: AiBinding;
}

/** Default Workers AI model — a solid general instruct model available on-edge. */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export type AiAction =
  | 'summarize'
  | 'improve_writing'
  | 'fix_grammar'
  | 'make_shorter'
  | 'make_longer'
  | 'continue_writing'
  | 'translate'
  | 'change_tone'
  | 'explain'
  | 'custom';

export interface AiAssistInput {
  action: AiAction;
  text: string;
  context?: string;
  instruction?: string;
  targetLang?: string;
  tone?: string;
}

export type AiAssistResult =
  | { ok: true; text: string }
  | { ok: false; status: 503 | 502 | 400; error: string };

/** Hard cap on input chars sent to the model — protects against a runaway
 * client payload. Longer text is truncated (with an ellipsis marker). */
export const MAX_INPUT_CHARS = 12_000;

/** Per-action max output tokens — continue/longer get more room. */
function maxTokensFor(action: AiAction): number {
  switch (action) {
    case 'make_longer':
    case 'continue_writing':
      return 800;
    case 'summarize':
    case 'explain':
      return 400;
    default:
      return 600;
  }
}

/** Build the system prompt that frames the assistant's job for an action.
 * Pure — exported for unit assertions on prompt shaping. */
export function systemPromptFor(input: AiAssistInput): string {
  const base =
    'You are a writing assistant embedded in a rich-text editor. ' +
    'Return ONLY the resulting text with no preamble, no quotes, no markdown code fences, ' +
    'and no commentary. Preserve the original language unless asked to translate.';
  switch (input.action) {
    case 'summarize':
      return `${base} Summarize the user's text concisely, keeping the key points.`;
    case 'improve_writing':
      return `${base} Improve the clarity, flow, and word choice of the user's text without changing its meaning.`;
    case 'fix_grammar':
      return `${base} Correct spelling, grammar, and punctuation in the user's text. Make no other changes.`;
    case 'make_shorter':
      return `${base} Make the user's text shorter and more concise while keeping its meaning.`;
    case 'make_longer':
      return `${base} Expand the user's text with more detail and supporting points, keeping the same voice.`;
    case 'continue_writing':
      return `${base} Continue writing naturally from where the user's text leaves off. Output ONLY the continuation, not a repeat of the provided text.`;
    case 'translate': {
      const lang = input.targetLang?.trim() || 'English';
      return `${base} Translate the user's text into ${lang}. Output only the translation.`;
    }
    case 'change_tone': {
      const tone = input.tone?.trim() || 'professional';
      return `${base} Rewrite the user's text in a ${tone} tone, keeping its meaning.`;
    }
    case 'explain':
      return `${base} Explain the user's text in plain, simple language.`;
    case 'custom':
      return `${base} Follow the user's instruction precisely.`;
  }
}

/** Build the user message for an action. Pure — exported for unit assertions. */
export function userMessageFor(input: AiAssistInput): string {
  const text = (input.text ?? '').slice(0, MAX_INPUT_CHARS);
  const truncated = (input.text?.length ?? 0) > MAX_INPUT_CHARS ? `${text}…` : text;
  if (input.action === 'custom') {
    const instruction = (input.instruction ?? '').trim();
    // A pure-instruction custom prompt (no selected text) just sends the ask.
    if (!truncated) return instruction;
    return `Instruction: ${instruction}\n\nText:\n${truncated}`;
  }
  if (input.action === 'continue_writing') {
    const ctx = (input.context ?? truncated).slice(0, MAX_INPUT_CHARS);
    return `Text so far:\n${ctx}`;
  }
  return truncated;
}

/** Whether the OpenAI-compatible backend is configured (both secrets present). */
export function aiConfigured(env: AiEnv): boolean {
  return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY);
}

/** Whether SOME AI backend is available (OpenAI-compat secrets OR Workers AI). */
export function aiAvailable(env: AiEnv): boolean {
  return aiConfigured(env) || Boolean(env.AI);
}

/**
 * A pre-resolved backend choice (from resolveAiBackendImpl) that the route
 * passes per-request, keyed on the page's workspace. When present it WINS over
 * the env/Workers-AI precedence baked into `aiAssistImpl`, so a workspace's
 * chosen provider takes effect. Kept structural (no import of ai-settings) so
 * `ai.ts` stays dependency-light + testable.
 */
export type ResolvedBackend =
  | { kind: 'openai'; baseUrl: string; apiKey: string; model?: string }
  | { kind: 'workers_ai' }
  | { kind: 'none' };

export interface AiAssistDeps {
  fetcher?: typeof fetch;
  /** Abort/timeout budget in ms (default 25s). */
  timeoutMs?: number;
  /**
   * Override for the Workers AI invocation (testing seam). When omitted, the
   * impl calls `env.AI.run(model, inputs)` directly. A fake `env.AI` works too;
   * this hook is for tests that want to assert the model/inputs in isolation.
   */
  aiRun?: (
    model: string,
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /**
   * Per-request resolved backend (per the page's workspace AI settings). When
   * provided it overrides the env-based precedence below. Omit to keep the
   * legacy env/Workers-AI selection (used by the existing tests + as fallback).
   */
  resolved?: ResolvedBackend;
}

/**
 * Run an AI assist action. Returns a discriminated result so the route can map
 * to an HTTP status without throwing:
 *   - 503 when the LLM isn't configured (missing secrets),
 *   - 400 when there's nothing to send (empty custom instruction + empty text),
 *   - 502 when the upstream LLM errors / times out.
 */
export async function aiAssistImpl(
  env: AiEnv,
  input: AiAssistInput,
  deps: AiAssistDeps = {},
): Promise<AiAssistResult> {
  // A per-request resolved backend (per the page's workspace) takes precedence
  // over the env-based selection; 'none' means nothing is configured anywhere.
  const resolved = deps.resolved;
  if (resolved) {
    if (resolved.kind === 'none') {
      return { ok: false, status: 503, error: 'AI not configured' };
    }
  } else if (!aiAvailable(env)) {
    return { ok: false, status: 503, error: 'AI not configured' };
  }

  const userMessage = userMessageFor(input);
  if (!userMessage.trim()) {
    return { ok: false, status: 400, error: 'nothing to send' };
  }

  // Shared prompt shaping — identical across both backends.
  const systemPrompt = systemPromptFor(input);
  const temperature = input.action === 'fix_grammar' ? 0.1 : 0.5;
  const maxTokens = maxTokensFor(input.action);
  const shaped: ShapedPrompt = { systemPrompt, userMessage, temperature, maxTokens };

  // 1. Resolved backend (workspace settings → env → Workers AI), when given.
  if (resolved) {
    if (resolved.kind === 'openai') {
      return openaiCompatAssist(
        { LLM_BASE_URL: resolved.baseUrl, LLM_API_KEY: resolved.apiKey, LLM_MODEL: resolved.model },
        shaped,
        deps,
      );
    }
    // resolved.kind === 'workers_ai'
    return workersAiAssist(env, shaped, deps);
  }

  // Legacy precedence (no resolver): explicit OpenAI-compat secrets override the
  // on-edge Workers AI default. (aiAvailable already guarantees one of the two.)
  if (aiConfigured(env)) {
    return openaiCompatAssist(env, shaped, deps);
  }
  return workersAiAssist(env, shaped, deps);
}

/** Prompt pieces shared by both backends. */
interface ShapedPrompt {
  systemPrompt: string;
  userMessage: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Cloudflare Workers AI backend (on-edge, no external key). Calls the `AI`
 * binding with the same messages/params as the OpenAI-compat path and parses
 * the `{ response }` shape into the handler's `{ text }` result.
 */
async function workersAiAssist(
  env: AiEnv,
  prompt: ShapedPrompt,
  deps: AiAssistDeps,
): Promise<AiAssistResult> {
  const model = env.WORKERS_AI_MODEL ?? env.LLM_MODEL ?? DEFAULT_WORKERS_AI_MODEL;
  const inputs: Record<string, unknown> = {
    messages: [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: prompt.userMessage },
    ],
    max_tokens: prompt.maxTokens,
    temperature: prompt.temperature,
  };
  /* v8 ignore next — real binding is the production default; tests inject one. */
  const run = deps.aiRun ?? ((m, i) => env.AI!.run(m, i));
  let out: Record<string, unknown>;
  try {
    out = await run(model, inputs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: `Workers AI failed: ${msg.slice(0, 200)}` };
  }
  const text = typeof out.response === 'string' ? out.response.trim() : '';
  if (!text) {
    return { ok: false, status: 502, error: 'Workers AI returned no content' };
  }
  return { ok: true, text };
}

/**
 * OpenAI-compatible `/chat/completions` backend. Unchanged behavior — used when
 * `LLM_BASE_URL` + `LLM_API_KEY` are set so the user can point at LiteLLM/OpenAI.
 */
async function openaiCompatAssist(
  env: AiEnv,
  prompt: ShapedPrompt,
  deps: AiAssistDeps,
): Promise<AiAssistResult> {
  const model = env.LLM_MODEL ?? 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    temperature: prompt.temperature,
    max_tokens: prompt.maxTokens,
    messages: [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: prompt.userMessage },
    ],
  });
  const url = `${env.LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`;

  // Bound the upstream call so a hung gateway can't hold the request open.
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 25_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* v8 ignore next — real fetch is the production default; tests inject one. */
  const fetcher = deps.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: `LLM request failed: ${msg.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: 502, error: `LLM ${res.status}: ${detail.slice(0, 200)}` };
  }
  let json: { choices?: Array<{ message?: { content?: string } }> };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { ok: false, status: 502, error: 'LLM returned invalid JSON' };
  }
  const out = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!out) {
    return { ok: false, status: 502, error: 'LLM returned no content' };
  }
  return { ok: true, text: out };
}
