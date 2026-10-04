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
import { EmptyState, EntryCardInner } from '~/routes/index';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('EntryCardInner', () => {
  it('renders title, source, time-ago, tags', () => {
    render(
      <EntryCardInner
        entry={{
          id: 7,
          title: 'Fix CORS',
          body: 'Add CORS header.',
          tags: ['cors', 'workerd'],
          source: 'cli',
          sourceRef: 'pm:pm#42',
          sourceUrl: null,
          createdAt: new Date(NOW - 12 * 60_000).toISOString(),
          updatedAt: new Date(NOW - 12 * 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    const card = screen.getByTestId('card-7');
    expect(card.textContent).toContain('Fix CORS');
    expect(card.textContent).toContain('12m ago');
    expect(screen.getByTestId('source-7')).toBeTruthy();
    expect(screen.getByTestId('tag-7-cors')).toBeTruthy();
    expect(screen.getByTestId('tag-7-workerd')).toBeTruthy();
  });

  it('omits source line when no source', () => {
    render(
      <EntryCardInner
        entry={{
          id: 1,
          title: 't',
          body: 'b',
          tags: [],
          source: null,
          sourceRef: null,
          sourceUrl: null,
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(NOW).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('source-1')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('shows the empty hint', () => {
    render(<EmptyState />);
    expect(screen.getByTestId('empty-state').textContent).toMatch(/Nothing solved yet/);
  });
});
