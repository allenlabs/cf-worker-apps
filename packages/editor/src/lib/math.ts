import katex from 'katex';

/**
 * Render a LaTeX source string to an HTML string via KaTeX. Pure + crash-proof:
 * on a parse error KaTeX (with `throwOnError: false`) renders the offending
 * source in red rather than throwing, so a bad equation never wedges the
 * editor. An empty source renders a muted placeholder so an empty math node is
 * still visible/clickable.
 *
 * Kept out of the node files so it's unit-testable without the ProseMirror
 * runtime.
 */
export function renderMath(src: string, displayMode: boolean): string {
  const latex = (src ?? '').trim();
  if (!latex) {
    return `<span class="ae-math-empty">${displayMode ? 'Empty equation' : 'math'}</span>`;
  }
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      // KaTeX colours errors red itself; keep that behaviour explicit.
      errorColor: '#dc2626',
      output: 'html',
    });
  } catch {
    // KaTeX should never throw with throwOnError:false, but belt-and-suspenders:
    // show the raw source in red rather than crashing the NodeView.
    const escaped = latex.replace(/[&<>]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
    );
    return `<span class="ae-math-error">${escaped}</span>`;
  }
}
