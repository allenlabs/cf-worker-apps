import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/Markdown';

describe('Markdown', () => {
  it('injects the provided html', () => {
    const { container } = render(<Markdown html="<p>hello</p>" />);
    expect(container.querySelector('p')!.textContent).toBe('hello');
  });

  it('appends the custom className', () => {
    const { container } = render(<Markdown html="x" className="prose" />);
    expect((container.firstChild as HTMLElement).className).toContain('markdown');
    expect((container.firstChild as HTMLElement).className).toContain('prose');
  });

  it('works with empty className', () => {
    const { container } = render(<Markdown html="x" />);
    expect((container.firstChild as HTMLElement).className).toContain('markdown');
  });
});
