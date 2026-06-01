import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
}));

import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { Highlight, SearchHitRow } from '~/routes/search';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

describe('Highlight', () => {
  it('marks <b>…</b> segments', () => {
    render(<Highlight headline="hello <b>world</b>!" />);
    const marks = screen.getAllByTestId('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('world');
  });

  it('renders [] for empty input', () => {
    const { container } = render(<Highlight headline="" />);
    expect(container.querySelectorAll('[data-testid="mark"]').length).toBe(0);
  });
});

describe('SearchHitRow', () => {
  const NOW = Date.parse('2026-05-24T12:00:00Z');
  it('renders title + headline + tags', () => {
    render(
      <SearchHitRow
        hit={{
          id: 9,
          title: 'CORS fix',
          body: 'b',
          tags: ['cors'],
          source: 'pr_merged',
          sourceRef: null,
          sourceUrl: null,
          createdAt: new Date(NOW - 60_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
          headline: 'Add <b>CORS</b> header',
          rank: 0.5,
        }}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('hit-9');
    expect(row.textContent).toContain('CORS fix');
    expect(row.textContent).toContain('pr_merged');
    expect(screen.getByTestId('mark')).toBeTruthy();
  });
});
