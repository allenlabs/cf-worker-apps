import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AI_SELECTION_ACTIONS,
  TRANSLATE_LANGS,
  DEFAULT_TONE,
  aiActionLabel,
  aiLabel,
} from '../src/lib/ai';
import { makeAskAiSlashItem, makeContinueWritingSlashItem } from '../src/lib/slash-items';
import type { AiAction } from '../src/lib/types';

describe('AI_SELECTION_ACTIONS', () => {
  it('covers the Notion-style selection actions with stable action values', () => {
    const actions = AI_SELECTION_ACTIONS.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'improve_writing',
        'fix_grammar',
        'make_shorter',
        'make_longer',
        'summarize',
        'explain',
        'change_tone',
        'translate',
      ] as AiAction[]),
    );
    // Every row has a label + icon + unique i18n key.
    const keys = AI_SELECTION_ACTIONS.map((a) => a.i18nKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of AI_SELECTION_ACTIONS) {
      expect(a.defaultLabel).toBeTruthy();
      expect(a.icon).toBeTruthy();
    }
  });

  it('marks translate rows with a target language and tone rows with needsTone', () => {
    const translates = AI_SELECTION_ACTIONS.filter((a) => a.action === 'translate');
    expect(translates.length).toBe(2); // descoped to English + Korean
    for (const t of translates) {
      expect(t.needsTargetLang).toBe(true);
      expect(TRANSLATE_LANGS[t.i18nKey]).toBeTruthy();
    }
    expect(TRANSLATE_LANGS['ai.translateEn']).toBe('English');
    expect(TRANSLATE_LANGS['ai.translateKo']).toBe('Korean');

    const tone = AI_SELECTION_ACTIONS.find((a) => a.action === 'change_tone');
    expect(tone?.needsTone).toBe(true);
    expect(DEFAULT_TONE).toBe('professional');
  });
});

describe('aiActionLabel / aiLabel', () => {
  const item = AI_SELECTION_ACTIONS[0]!;

  it('returns the default label with no translator', () => {
    expect(aiActionLabel(item)).toBe(item.defaultLabel);
    expect(aiLabel('ai.ask', 'Ask AI')).toBe('Ask AI');
  });

  it('uses the translator when it resolves the key', () => {
    const t = (k: string) => (k === item.i18nKey ? '문장 다듬기' : k);
    expect(aiActionLabel(item, t)).toBe('문장 다듬기');
    expect(aiLabel('ai.ask', 'Ask AI', (k) => (k === 'ai.ask' ? 'AI에게 묻기' : k))).toBe(
      'AI에게 묻기',
    );
  });

  it('falls back to default when the translator echoes the key (missing)', () => {
    const echo = (k: string) => k;
    expect(aiActionLabel(item, echo)).toBe(item.defaultLabel);
    expect(aiLabel('ai.ask', 'Ask AI', echo)).toBe('Ask AI');
  });
});

/** Editor chain stub recording inserted content + deleteRange calls. */
function makeEditorStub(precedingText = '') {
  const calls: string[] = [];
  const inserted: string[] = [];
  const chain = {
    focus: () => chain,
    deleteRange: () => {
      calls.push('deleteRange');
      return chain;
    },
    insertContent: (text: string) => {
      inserted.push(text);
      return chain;
    },
    run: () => true,
  };
  const editor = {
    chain: () => chain,
    state: { doc: { textBetween: () => precedingText } },
  };
  return { editor, calls, inserted };
}

describe('makeAskAiSlashItem', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { prompt: vi.fn().mockReturnValue('Write a haiku') });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds an "Ask AI" item with ai keywords', () => {
    const item = makeAskAiSlashItem(async () => 'x');
    expect(item.title).toBe('Ask AI');
    expect(item.keywords).toContain('ai');
    expect(item.icon).toBe('✨');
  });

  it('prompts for an instruction, calls askAI with custom action, inserts result', async () => {
    const askAI = vi.fn().mockResolvedValue('An old silent pond…');
    const item = makeAskAiSlashItem(askAI);
    const { editor, calls, inserted } = makeEditorStub();

    item.command({ editor: editor as never, range: { from: 1, to: 2 } as never });
    expect(calls).toContain('deleteRange');
    await Promise.resolve();
    await Promise.resolve();

    expect(askAI).toHaveBeenCalledWith({
      action: 'custom',
      text: '',
      instruction: 'Write a haiku',
    });
    expect(inserted).toEqual(['An old silent pond…']);
  });

  it('inserts nothing when the prompt is cancelled', async () => {
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const askAI = vi.fn();
    const item = makeAskAiSlashItem(askAI);
    const { editor } = makeEditorStub();
    item.command({ editor: editor as never, range: { from: 1, to: 2 } as never });
    await Promise.resolve();
    expect(askAI).not.toHaveBeenCalled();
  });
});

describe('makeContinueWritingSlashItem', () => {
  it('sends preceding text as context for continue_writing and inserts result', async () => {
    const askAI = vi.fn().mockResolvedValue(' and then the sun rose.');
    const item = makeContinueWritingSlashItem(askAI);
    const { editor, calls, inserted } = makeEditorStub('The night was long');

    item.command({ editor: editor as never, range: { from: 18, to: 19 } as never });
    expect(calls).toContain('deleteRange');
    await Promise.resolve();
    await Promise.resolve();

    expect(askAI).toHaveBeenCalledWith({
      action: 'continue_writing',
      text: 'The night was long',
      context: 'The night was long',
    });
    expect(inserted).toEqual([' and then the sun rose.']);
  });

  it('uses host-translated labels when provided', () => {
    const item = makeContinueWritingSlashItem(async () => '', {
      title: '이어 쓰기',
      hint: 'AI가 이어서 작성',
    });
    expect(item.title).toBe('이어 쓰기');
    expect(item.hint).toBe('AI가 이어서 작성');
  });
});
