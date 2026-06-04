// AI assist impl. A pure, dependency-injected function that maps an editor AI
// action to an action-specific system+user prompt, calls an OpenAI-compatible
// `/chat/completions` endpoint via an injected fetcher, and returns `{ text }`.
//
// Mirrors the concierge cron LLM client (plain `fetch`, no SDK). Network stays
// behind the editor-api HMAC gate — the @allenlabs/editor package never calls
// an LLM directly; the host's `askAI` hook routes here through editor-web.
//
// Kept Hono/Cloudflare-free so it's unit-testable with a fake fetcher.

/** OpenAI-compatible LLM config. All three are OPTIONAL secrets on editor-api;
 * when any is unset the route returns a 503 "AI not configured" (no crash). */
export interface AiEnv {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

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

/** Whether the LLM is configured (all three required secrets present). */
export function aiConfigured(env: AiEnv): boolean {
  return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY);
}

export interface AiAssistDeps {
  fetcher?: typeof fetch;
  /** Abort/timeout budget in ms (default 25s). */
  timeoutMs?: number;
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
  if (!aiConfigured(env)) {
    return { ok: false, status: 503, error: 'AI not configured' };
  }
  const userMessage = userMessageFor(input);
  if (!userMessage.trim()) {
    return { ok: false, status: 400, error: 'nothing to send' };
  }

  const model = env.LLM_MODEL ?? 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    temperature: input.action === 'fix_grammar' ? 0.1 : 0.5,
    max_tokens: maxTokensFor(input.action),
    messages: [
      { role: 'system', content: systemPromptFor(input) },
      { role: 'user', content: userMessage },
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
