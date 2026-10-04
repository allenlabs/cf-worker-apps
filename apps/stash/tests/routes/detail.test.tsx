import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
  createFileRoute: () => () => ({}),
  useRouter: () => ({ navigate: () => {}, invalidate: () => {} }),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: () => () => Promise.resolve(null) }),
    handler: () => () => Promise.resolve(null),
  }),
}));

import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { CopyButton, DetailHeader } from '~/routes/snippet.$id';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = Date.parse('2026-05-24T12:00:00Z');

describe('DetailHeader', () => {
  it('renders title, save time, language, source, and tags', () => {
    render(
      <DetailHeader
        snippet={{
          id: 1,
          title: 'curl example',
          body: 'curl example.com',
          language: 'sh',
          tags: ['curl', 'http'],
          source: 'cli',
          createdAt: new Date(NOW - 60_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    const el = screen.getByTestId('detail-header');
    expect(el.textContent).toContain('curl example');
    expect(el.textContent).toContain('shell');
    expect(el.textContent).toContain('via cli');
    expect(screen.getByTestId('tag-curl')).toBeTruthy();
    expect(screen.getByTestId('tag-http')).toBeTruthy();
  });

  it('falls back to (untitled snippet) when no title', () => {
    render(
      <DetailHeader
        snippet={{
          id: 1,
          title: null,
          body: 'x',
          language: null,
          tags: [],
          source: null,
          createdAt: new Date(NOW - 60_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('detail-header').textContent).toContain('(untitled snippet)');
  });

  it('shows the edited time when different from created', () => {
    render(
      <DetailHeader
        snippet={{
          id: 1,
          title: 't',
          body: 'b',
          language: null,
          tags: [],
          source: null,
          createdAt: new Date(NOW - 60 * 60_000).toISOString(),
          updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
        }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('detail-header').textContent).toMatch(/edited/);
  });
});

describe('CopyButton', () => {
  it('renders an idle Copy label', () => {
    render(<CopyButton text="hello" />);
    expect(screen.getByTestId('copy-button').textContent).toBe('Copy');
  });
});
