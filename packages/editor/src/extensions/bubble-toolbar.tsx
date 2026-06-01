import { BubbleMenu } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { CommentConfig } from '../lib/types';

interface Props {
  editor: Editor;
  /** When set, adds a "💬" button that anchors a comment thread to the selection. */
  comments?: CommentConfig;
}

/** Plain text inside the current selection (for the thread's anchor snippet). */
function selectedTextOf(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, ' ');
}

/**
 * Floating selection toolbar — bold / italic / underline / strike / code,
 * a link toggle (URL prompt), highlight, and (when wired) an inline-comment
 * button. Shown by TipTap's BubbleMenu whenever a non-empty text range is
 * selected.
 */
export function BubbleToolbar({ editor, comments }: Props) {
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

  const btn = (active: boolean) => `ae-bubble-btn${active ? ' ae-bubble-active' : ''}`;

  return (
    <BubbleMenu editor={editor} className="ae-bubble-menu">
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
    </BubbleMenu>
  );
}
