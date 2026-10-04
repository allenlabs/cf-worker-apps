import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

import { render, screen } from '@testing-library/react';
import { Highlight } from '~/routes/search';

describe('Highlight', () => {
  it('renders <mark> for <b>...</b> markers', () => {
    render(<Highlight headline="before <b>match</b> after" />);
    const marks = screen.getAllByTestId('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('match');
    expect(screen.getByTestId('highlight').textContent).toBe('before match after');
  });
  it('renders multiple marks', () => {
    render(<Highlight headline="<b>a</b> + <b>b</b>" />);
    expect(screen.getAllByTestId('mark').length).toBe(2);
  });
  it('renders an empty headline', () => {
    const { container } = render(<Highlight headline="" />);
    expect(container.querySelector('[data-testid="highlight"]')).toBeTruthy();
  });
});
