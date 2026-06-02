import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { renderMath } from '../lib/math';

/**
 * Inline math NodeView. Renders KaTeX output; clicking (when editable) opens a
 * small inline textarea to edit the LaTeX source. Atom from ProseMirror's view,
 * so the source lives in the `latex` attr and edits go through
 * `updateAttributes` (which syncs via Yjs in collab mode).
 */
export function InlineMathView(props: NodeViewProps) {
  const latex = (props.node.attrs.latex as string) || '';
  const editable = props.editor.isEditable;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setDraft(latex), [latex]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== latex) props.updateAttributes({ latex: draft });
  }

  return (
    <NodeViewWrapper as="span" className="ae-inline-math" data-type="inline-math" data-testid="inline-math">
      {editing ? (
        <input
          ref={inputRef}
          className="ae-math-input ae-math-input-inline"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(latex);
              setEditing(false);
            }
          }}
          aria-label="Edit inline equation"
        />
      ) : (
        <span
          className="ae-math-render"
          contentEditable={false}
          // KaTeX output is trusted (we generate it); render errors are red text.
          dangerouslySetInnerHTML={{ __html: renderMath(latex, false) }}
          onClick={() => editable && setEditing(true)}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Block (display) math NodeView. Shows the rendered equation; clicking (when
 * editable) reveals a textarea for the LaTeX source. Pressing the source area's
 * blur or Cmd/Ctrl+Enter commits. Read-only viewers only ever see the render.
 */
export function MathBlockView(props: NodeViewProps) {
  const latex = (props.node.attrs.latex as string) || '';
  const editable = props.editor.isEditable;
  // Auto-open the editor for a freshly-inserted (empty) block so the user can
  // start typing immediately.
  const [editing, setEditing] = useState(editable && latex.trim() === '');
  const [draft, setDraft] = useState(latex);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setDraft(latex), [latex]);
  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== latex) props.updateAttributes({ latex: draft });
  }

  return (
    <NodeViewWrapper className="ae-math-block" data-type="math-block" data-testid="math-block">
      {editing ? (
        <textarea
          ref={areaRef}
          className="ae-math-input ae-math-input-block"
          value={draft}
          placeholder="E = mc^2"
          rows={Math.max(2, draft.split('\n').length)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(latex);
              setEditing(false);
            }
          }}
          aria-label="Edit equation"
        />
      ) : (
        <div
          className="ae-math-render ae-math-render-block"
          contentEditable={false}
          dangerouslySetInnerHTML={{ __html: renderMath(latex, true) }}
          onClick={() => editable && setEditing(true)}
        />
      )}
    </NodeViewWrapper>
  );
}
