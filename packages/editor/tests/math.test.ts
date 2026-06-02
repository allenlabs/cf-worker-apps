import { describe, expect, it } from 'vitest';
import { renderMath } from '../src/lib/math';

describe('renderMath', () => {
  it('renders valid LaTeX to KaTeX HTML', () => {
    const html = renderMath('x^2', false);
    expect(html).toContain('katex');
    expect(html).not.toContain('ae-math-empty');
  });

  it('renders display mode for block math', () => {
    const html = renderMath('\\int_0^1 x\\,dx', true);
    expect(html).toContain('katex');
  });

  it('shows a placeholder for empty source', () => {
    expect(renderMath('', false)).toContain('ae-math-empty');
    expect(renderMath('   ', true)).toContain('ae-math-empty');
  });

  it('does not throw on invalid LaTeX (renders error inline, red)', () => {
    expect(() => renderMath('\\frac{1}{', false)).not.toThrow();
    const html = renderMath('\\frac{1}{', false);
    // KaTeX with throwOnError:false emits the source in an error color.
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});
