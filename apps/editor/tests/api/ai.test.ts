// Unit tests for the editor-api AI assist impl. Drives a FAKE fetcher (never a
// real LLM) to assert: per-action prompt shaping, the unconfigured → 503 path,
// input truncation, empty-input → 400, and upstream error handling.

import { describe, it, expect, vi } from 'vitest';
import {
  aiAssistImpl,
  aiConfigured,
  aiAvailable,
  systemPromptFor,
  userMessageFor,
  MAX_INPUT_CHARS,
  DEFAULT_WORKERS_AI_MODEL,
  type AiEnv,
  type AiBinding,
  type AiAssistInput,
} from '@api/handlers/ai';

const CONFIGURED: AiEnv = {
  LLM_BASE_URL: 'https://llm.example/v1',
  LLM_API_KEY: 'sk-test',
  LLM_MODEL: 'test-model',
};

/** A fake fetcher that returns one chat-completions choice. Records the request. */
function fakeFetch(content: string) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** A fake Workers AI binding returning a `{ response }` text-generation output.
 * Records each `run(model, inputs)` call. */
function fakeAi(response: string) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  const binding: AiBinding = {
    run: vi.fn(async (model: string, inputs: Record<string, unknown>) => {
      calls.push({ model, inputs });
      return { response };
    }),
  };
  return { binding, calls };
}

describe('aiConfigured', () => {
  it('requires both base url and api key', () => {
    expect(aiConfigured(CONFIGURED)).toBe(true);
    expect(aiConfigured({ LLM_API_KEY: 'k' })).toBe(false);
    expect(aiConfigured({ LLM_BASE_URL: 'u' })).toBe(false);
    expect(aiConfigured({})).toBe(false);
  });
});

describe('aiAvailable', () => {
  it('is true when OpenAI-compat secrets are set OR a Workers AI binding exists', () => {
    expect(aiAvailable(CONFIGURED)).toBe(true);
    expect(aiAvailable({ AI: fakeAi('x').binding })).toBe(true);
    expect(aiAvailable({})).toBe(false);
    // A lone Workers AI binding (no LLM secrets) still counts as available.
    expect(aiAvailable({ AI: fakeAi('x').binding, LLM_BASE_URL: 'u' })).toBe(true);
  });
});

describe('systemPromptFor', () => {
  it('shapes a distinct system prompt per action', () => {
    const mk = (action: AiAssistInput['action'], extra?: Partial<AiAssistInput>) =>
      systemPromptFor({ action, text: 't', ...extra });
    expect(mk('fix_grammar')).toMatch(/grammar/i);
    expect(mk('make_shorter')).toMatch(/shorter|concise/i);
    expect(mk('make_longer')).toMatch(/expand|longer|detail/i);
    expect(mk('summarize')).toMatch(/summar/i);
    expect(mk('continue_writing')).toMatch(/continue/i);
    expect(mk('explain')).toMatch(/explain/i);
    // translate folds the target language into the prompt
    expect(mk('translate', { targetLang: 'Korean' })).toMatch(/Korean/);
    // translate defaults to English when no language given
    expect(mk('translate')).toMatch(/English/);
    // change_tone folds the tone in (default professional)
    expect(mk('change_tone', { tone: 'casual' })).toMatch(/casual/);
    expect(mk('change_tone')).toMatch(/professional/);
    // every prompt forbids preamble/markdown
    expect(mk('improve_writing')).toMatch(/ONLY/);
  });
});

describe('userMessageFor', () => {
  it('passes the text through for a plain action', () => {
    expect(userMessageFor({ action: 'summarize', text: 'hello world' })).toBe('hello world');
  });

  it('combines instruction + text for custom, or just the instruction when no text', () => {
    expect(
      userMessageFor({ action: 'custom', text: 'Some draft', instruction: 'make it rhyme' }),
    ).toMatch(/Instruction: make it rhyme[\s\S]*Some draft/);
    expect(userMessageFor({ action: 'custom', text: '', instruction: 'write a poem' })).toBe(
      'write a poem',
    );
  });

  it('uses context for continue_writing', () => {
    expect(
      userMessageFor({ action: 'continue_writing', text: 'ignored', context: 'the story so far' }),
    ).toBe('Text so far:\nthe story so far');
  });

  it('truncates over-long input', () => {
    const long = 'a'.repeat(MAX_INPUT_CHARS + 500);
    const out = userMessageFor({ action: 'summarize', text: long });
    expect(out.length).toBe(MAX_INPUT_CHARS + 1); // truncated + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('aiAssistImpl', () => {
  it('returns 503 when the LLM is not configured (no crash)', async () => {
    const res = await aiAssistImpl({}, { action: 'summarize', text: 'x' });
    expect(res).toEqual({ ok: false, status: 503, error: 'AI not configured' });
  });

  it('returns 400 when there is nothing to send', async () => {
    const res = await aiAssistImpl(CONFIGURED, { action: 'custom', text: '', instruction: '   ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('calls the chat-completions endpoint with the shaped prompt and returns text', async () => {
    const { fn, calls } = fakeFetch('  Polished text.  ');
    const res = await aiAssistImpl(
      CONFIGURED,
      { action: 'improve_writing', text: 'rough text' },
      { fetcher: fn },
    );
    expect(res).toEqual({ ok: true, text: 'Polished text.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://llm.example/v1/chat/completions');
    const body = calls[0]!.body as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('test-model');
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toMatch(/Improve/i);
    expect(body.messages[1]!).toEqual({ role: 'user', content: 'rough text' });
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('defaults the model when LLM_MODEL is unset', async () => {
    const { fn, calls } = fakeFetch('ok');
    await aiAssistImpl(
      { LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'k' },
      { action: 'summarize', text: 'hi' },
      { fetcher: fn },
    );
    expect((calls[0]!.body as { model: string }).model).toBe('gpt-4o-mini');
  });

  it('maps an upstream non-2xx to a 502', async () => {
    const fn = vi.fn(async () => new Response('upstream boom', { status: 500 }));
    const res = await aiAssistImpl(
      CONFIGURED,
      { action: 'summarize', text: 'x' },
      { fetcher: fn as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(502);
      expect(res.error).toMatch(/LLM 500/);
    }
  });

  it('maps a thrown fetch (e.g. abort/timeout) to a 502', async () => {
    const fn = vi.fn(async () => {
      throw new Error('aborted');
    });
    const res = await aiAssistImpl(
      CONFIGURED,
      { action: 'summarize', text: 'x' },
      { fetcher: fn as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });

  it('maps empty model content to a 502', async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    );
    const res = await aiAssistImpl(
      CONFIGURED,
      { action: 'summarize', text: 'x' },
      { fetcher: fn as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });

  it('uses a lower temperature for fix_grammar', async () => {
    const { fn, calls } = fakeFetch('fixed');
    await aiAssistImpl(CONFIGURED, { action: 'fix_grammar', text: 'teh cat' }, { fetcher: fn });
    expect((calls[0]!.body as { temperature: number }).temperature).toBe(0.1);
  });

  // ---- Workers AI default backend (no LLM_BASE_URL/LLM_API_KEY) ----

  it('uses the Workers AI binding when no OpenAI-compat secrets are set', async () => {
    const { binding, calls } = fakeAi('  On-edge polished.  ');
    const res = await aiAssistImpl({ AI: binding }, { action: 'improve_writing', text: 'rough' });
    // Parses `{ response }` into `{ text }`, trimmed.
    expect(res).toEqual({ ok: true, text: 'On-edge polished.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    // Same prompt shaping as the OpenAI-compat path: system+user messages.
    const inputs = calls[0]!.inputs as {
      messages: { role: string; content: string }[];
      max_tokens: number;
      temperature: number;
    };
    expect(inputs.messages[0]!.role).toBe('system');
    expect(inputs.messages[0]!.content).toMatch(/Improve/i);
    expect(inputs.messages[1]!).toEqual({ role: 'user', content: 'rough' });
    expect(inputs.temperature).toBe(0.5);
    expect(typeof inputs.max_tokens).toBe('number');
  });

  it('shapes a per-action prompt for the Workers AI path (translate)', async () => {
    const { binding, calls } = fakeAi('안녕하세요');
    const res = await aiAssistImpl(
      { AI: binding },
      { action: 'translate', text: 'hello', targetLang: 'Korean' },
    );
    expect(res).toEqual({ ok: true, text: '안녕하세요' });
    const inputs = calls[0]!.inputs as { messages: { content: string }[] };
    expect(inputs.messages[0]!.content).toMatch(/Korean/);
  });

  it('honors WORKERS_AI_MODEL (then LLM_MODEL) override on the Workers AI path', async () => {
    const a = fakeAi('x');
    await aiAssistImpl(
      { AI: a.binding, WORKERS_AI_MODEL: '@cf/custom/model' },
      { action: 'summarize', text: 'hi' },
    );
    expect(a.calls[0]!.model).toBe('@cf/custom/model');

    const b = fakeAi('x');
    await aiAssistImpl(
      { AI: b.binding, LLM_MODEL: '@cf/from/llm-model' },
      { action: 'summarize', text: 'hi' },
    );
    expect(b.calls[0]!.model).toBe('@cf/from/llm-model');
  });

  it('OpenAI-compat secrets take precedence over the Workers AI binding', async () => {
    const { fn, calls } = fakeFetch('via fetch');
    const ai = fakeAi('via binding');
    const res = await aiAssistImpl(
      { ...CONFIGURED, AI: ai.binding },
      { action: 'summarize', text: 'hi' },
      { fetcher: fn },
    );
    expect(res).toEqual({ ok: true, text: 'via fetch' });
    expect(calls).toHaveLength(1); // fetch path used
    expect(ai.binding.run).not.toHaveBeenCalled(); // binding untouched
  });

  it('maps a thrown Workers AI run to a 502', async () => {
    const binding: AiBinding = {
      run: vi.fn(async () => {
        throw new Error('inference unavailable');
      }),
    };
    const res = await aiAssistImpl({ AI: binding }, { action: 'summarize', text: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(502);
      expect(res.error).toMatch(/Workers AI failed/);
    }
  });

  it('maps an empty Workers AI response to a 502', async () => {
    const res = await aiAssistImpl({ AI: fakeAi('').binding }, { action: 'summarize', text: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });

  it('supports the deps.aiRun testing seam', async () => {
    const aiRun = vi.fn(async () => ({ response: 'from seam' }));
    const res = await aiAssistImpl(
      { AI: fakeAi('unused').binding },
      { action: 'summarize', text: 'x' },
      { aiRun },
    );
    expect(res).toEqual({ ok: true, text: 'from seam' });
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it('still returns 503 when NEITHER backend is available', async () => {
    const res = await aiAssistImpl({}, { action: 'summarize', text: 'x' });
    expect(res).toEqual({ ok: false, status: 503, error: 'AI not configured' });
  });

  // ---- Per-request resolved backend (per-workspace AI settings) ----

  it('uses a resolved openai backend (workspace settings) over env/Workers AI', async () => {
    const { fn, calls } = fakeFetch('via workspace provider');
    const ai = fakeAi('via binding');
    // env has BOTH the Workers AI binding and (legacy) LLM secrets, but the
    // resolved backend (the workspace's choice) must win.
    const res = await aiAssistImpl(
      { ...CONFIGURED, AI: ai.binding },
      { action: 'improve_writing', text: 'rough' },
      {
        fetcher: fn,
        resolved: {
          kind: 'openai',
          baseUrl: 'https://ws.example/v1',
          apiKey: 'sk-ws',
          model: 'ws-model',
        },
      },
    );
    expect(res).toEqual({ ok: true, text: 'via workspace provider' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ws.example/v1/chat/completions');
    expect((calls[0]!.body as { model: string }).model).toBe('ws-model');
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe('Bearer sk-ws');
    expect(ai.binding.run).not.toHaveBeenCalled();
  });

  it('uses Workers AI when the resolved backend is workers_ai (even with LLM secrets in env)', async () => {
    const { binding, calls } = fakeAi('on-edge');
    const fetchSpy = vi.fn();
    const res = await aiAssistImpl(
      { ...CONFIGURED, AI: binding },
      { action: 'summarize', text: 'hi' },
      { resolved: { kind: 'workers_ai' }, fetcher: fetchSpy as unknown as typeof fetch },
    );
    expect(res).toEqual({ ok: true, text: 'on-edge' });
    expect(calls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // the OpenAI-compat path was NOT taken
  });

  it('returns 503 when the resolved backend is none (even if env has a binding)', async () => {
    const res = await aiAssistImpl(
      { AI: fakeAi('x').binding },
      { action: 'summarize', text: 'x' },
      { resolved: { kind: 'none' } },
    );
    expect(res).toEqual({ ok: false, status: 503, error: 'AI not configured' });
  });
});
