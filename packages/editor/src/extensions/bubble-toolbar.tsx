import { BubbleMenu } from '@tiptap/react';
import { useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { AiAssistInput, AiAction, CommentConfig } from '../lib/types';
import {
  AI_SELECTION_ACTIONS,
  TRANSLATE_LANGS,
  DEFAULT_TONE,
  aiActionLabel,
  aiLabel,
  type AiMenuAction,
} from '../lib/ai';

interface Props {
  editor: Editor;
  /** When set, adds a "💬" button that anchors a comment thread to the selection. */
  comments?: CommentConfig;
  /**
   * AI assist hook (host-provided). When set, adds an "✨ AI" button that opens
   * an action menu; the package never calls an LLM directly.
   */
  askAI?: (input: AiAssistInput) => Promise<string>;
  /** Translate AI menu labels (optional). */
  aiT?: (key: string) => string;
}

/** Plain text inside the current selection (for the thread's anchor snippet). */
function selectedTextOf(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, ' ');
}

/** Build the {@link AiAssistInput} for a chosen menu row + selected text. */
function inputFor(item: AiMenuAction, text: string): AiAssistInput {
  const input: AiAssistInput = { action: item.action, text };
  if (item.needsTargetLang) input.targetLang = TRANSLATE_LANGS[item.i18nKey] ?? 'English';
  if (item.needsTone) input.tone = DEFAULT_TONE;
  return input;
}

type AiPhase =
  | { kind: 'idle' }
  | { kind: 'menu' }
  | { kind: 'loading' }
  | { kind: 'result'; text: string }
  | { kind: 'error' };

/**
 * Floating selection toolbar — bold / italic / underline / strike / code,
 * a link toggle (URL prompt), highlight, an inline-comment button (when wired),
 * and an "✨ AI" button (when `askAI` is wired). The AI panel is rendered as
 * plain DOM INSIDE this React-managed BubbleMenu — no separate ReactRenderer
 * portal — so it can't reproduce the empty-popup bug the slash menu had.
 */
export function BubbleToolbar({ editor, comments, askAI, aiT }: Props) {
  const [phase, setPhase] = useState<AiPhase>({ kind: 'idle' });

  function addComment() {
    if (editor.state.selection.empty || !comments) return;
    const text = selectedTextOf(editor);
    const threadId = crypto.randomUUID();
    editor.chain().focus().setCommentThread(threadId).run();
    comments.onCreate(threadId, text);
  }

  function toggleLink() {
    const prev = (editor.getAttributes('link').href as string) ?? '';
    const url = window.prompt('Link URL', prev);
    if (url === null) return; // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  async function runAi(item: AiMenuAction) {
    if (!askAI) return;
    const text = selectedTextOf(editor);
    setPhase({ kind: 'loading' });
    try {
      const out = await askAI(inputFor(item, text));
      setPhase({ kind: 'result', text: out });
    } catch {
      setPhase({ kind: 'error' });
    }
  }

  /** Replace the current selection with the AI result, preserving paragraphs. */
  function replaceSelection(text: string) {
    editor.chain().focus().insertContent(text).run();
    setPhase({ kind: 'idle' });
  }

  /** Insert the AI result as a new paragraph after the selection. */
  function insertBelow(text: string) {
    const { to } = editor.state.selection;
    editor
      .chain()
      .focus()
      .insertContentAt(to, { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
      .run();
    setPhase({ kind: 'idle' });
  }

  const btn = (active: boolean) => `ae-bubble-btn${active ? ' ae-bubble-active' : ''}`;

  return (
    <BubbleMenu editor={editor} className="ae-bubble-menu">
      {phase.kind === 'idle' ? (
        <>
          <button
            type="button"
            className={btn(editor.isActive('bold'))}
            data-testid="bubble-bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={btn(editor.isActive('italic'))}
            data-testid="bubble-italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <em>i</em>
          </button>
          <button
            type="button"
            className={btn(editor.isActive('underline'))}
            data-testid="bubble-underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Underline"
          >
            <u>U</u>
          </button>
          <button
            type="button"
            className={btn(editor.isActive('strike'))}
            data-testid="bubble-strike"
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <s>S</s>
          </button>
          <button
            type="button"
            className={btn(editor.isActive('code'))}
            data-testid="bubble-code"
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Code"
          >
            {'</>'}
          </button>
          <button
            type="button"
            className={btn(editor.isActive('highlight'))}
            data-testid="bubble-highlight"
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            title="Highlight"
          >
            <span className="ae-bubble-hl">H</span>
          </button>
          <button
            type="button"
            className={btn(editor.isActive('link'))}
            data-testid="bubble-link"
            onClick={toggleLink}
            title="Link"
          >
            🔗
          </button>
          {comments ? (
            <button
              type="button"
              className={btn(editor.isActive('comment'))}
              data-testid="bubble-comment"
              onClick={addComment}
              title="Comment"
            >
              💬
            </button>
          ) : null}
          {askAI ? (
            <button
              type="button"
              className="ae-bubble-btn ae-bubble-ai"
              data-testid="bubble-ai"
              onClick={() => setPhase({ kind: 'menu' })}
              title={aiLabel('ai.ask', 'Ask AI', aiT)}
            >
              ✨ {aiLabel('ai.label', 'AI', aiT)}
            </button>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'menu' ? (
        <div className="ae-ai-menu" data-testid="ai-menu">
          {AI_SELECTION_ACTIONS.map((item) => (
            <button
              type="button"
              key={item.i18nKey}
              className="ae-ai-menu-item"
              data-testid={`ai-action-${item.i18nKey}`}
              data-action={item.action as AiAction}
              onClick={() => void runAi(item)}
            >
              <span className="ae-ai-menu-icon">{item.icon}</span>
              {aiActionLabel(item, aiT)}
            </button>
          ))}
          <button
            type="button"
            className="ae-ai-menu-item ae-ai-menu-cancel"
            data-testid="ai-cancel"
            onClick={() => setPhase({ kind: 'idle' })}
          >
            {aiLabel('ai.cancel', 'Cancel', aiT)}
          </button>
        </div>
      ) : null}

      {phase.kind === 'loading' ? (
        <div className="ae-ai-loading" data-testid="ai-loading">
          {aiLabel('ai.thinking', 'Thinking…', aiT)}
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="ae-ai-result" data-testid="ai-error">
          <div className="ae-ai-error-text">{aiLabel('ai.error', 'AI request failed.', aiT)}</div>
          <div className="ae-ai-result-actions">
            <button
              type="button"
              className="ae-ai-result-btn"
              data-testid="ai-discard"
              onClick={() => setPhase({ kind: 'idle' })}
            >
              {aiLabel('ai.discard', 'Discard', aiT)}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'result' ? (
        <div className="ae-ai-result" data-testid="ai-result">
          <div className="ae-ai-result-text">{phase.text}</div>
          <div className="ae-ai-result-actions">
            <button
              type="button"
              className="ae-ai-result-btn"
              data-testid="ai-replace"
              onClick={() => replaceSelection(phase.text)}
            >
              {aiLabel('ai.replace', 'Replace selection', aiT)}
            </button>
            <button
              type="button"
              className="ae-ai-result-btn"
              data-testid="ai-insert-below"
              onClick={() => insertBelow(phase.text)}
            >
              {aiLabel('ai.insertBelow', 'Insert below', aiT)}
            </button>
            <button
              type="button"
              className="ae-ai-result-btn"
              data-testid="ai-discard"
              onClick={() => setPhase({ kind: 'idle' })}
            >
              {aiLabel('ai.discard', 'Discard', aiT)}
            </button>
          </div>
        </div>
      ) : null}
    </BubbleMenu>
  );
}
