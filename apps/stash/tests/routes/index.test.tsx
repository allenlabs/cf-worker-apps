import { describe, expect, it, vi } from 'vitest';

// Avoid pulling in the real router context; the unit tests render presentational
// pieces only.  Same trick as tests/components/Header.test.tsx.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
}));

import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  EmptyState,
  Paginator,
  SnippetCardInner,
} from '~/routes/index';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('SnippetCardInner', () => {
  it('renders title + time-ago + language + tags', () => {
    render(
      <SnippetCardInner
        snippet={{
          id: 7,
          title: 'curl example',
          body: 'curl example.com',
          language: 'sh',
          tags: ['curl', 'http'],
          source: 'cli',
          createdAt: new Date(NOW - 12 * 60_000).toISOString(),
          updatedAt: new Date(NOW - 12 * 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    const card = screen.getByTestId('card-7');
    expect(card.textContent).toContain('curl example');
    expect(card.textContent).toContain('12m ago');
    expect(card.textContent).toContain('shell');
    expect(screen.getByTestId('tag-7-curl')).toBeTruthy();
    expect(screen.getByTestId('tag-7-http')).toBeTruthy();
  });

  it('falls back to a body preview when no title', () => {
    render(
      <SnippetCardInner
        snippet={{
          id: 1,
          title: null,
          body: 'plain body content',
          language: null,
          tags: [],
          source: null,
          createdAt: new Date(NOW - 60_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('card-1').textContent).toContain('plain body content');
  });

  it('shows (untitled) when title and body are both empty-ish', () => {
    render(
      <SnippetCardInner
        snippet={{
          id: 2,
          title: null,
          body: '   ',
          language: null,
          tags: [],
          source: null,
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(NOW).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('card-2').textContent).toContain('(untitled)');
  });
});

describe('EmptyState', () => {
  it('shows the empty hint', () => {
    render(<EmptyState />);
    expect(screen.getByTestId('empty-state').textContent).toMatch(/Nothing stashed yet/);
  });
});

describe('Paginator', () => {
  it('renders nothing when total <= pageSize', () => {
    const { container } = render(
      <Paginator page={1} total={10} pageSize={20} basePath="/" />,
    );
    expect(container.querySelector('[data-testid="paginator"]')).toBeNull();
  });

  it('renders page links for many pages', () => {
    render(<Paginator page={5} total={200} pageSize={20} basePath="/" />);
    expect(screen.getByTestId('paginator')).toBeTruthy();
    expect(screen.getByTestId('page-1')).toBeTruthy();
    expect(screen.getByTestId('page-5')).toBeTruthy();
    expect(screen.getByTestId('page-10')).toBeTruthy();
  });
});
