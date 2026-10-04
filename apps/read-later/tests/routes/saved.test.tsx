import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...rest
    }: { children: React.ReactNode; to?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to ?? ''} {...rest}>
        {children}
      </a>
    ),
    useRouter: () => ({ invalidate: () => {}, navigate: () => {} }),
  };
});

import { ReaderBody, ReaderHeader } from '~/routes/saved.$id';
import type { ItemDetail } from '~/server/read-later';

const NOW = Date.parse('2026-05-24T12:00:00Z');

function makeDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: 7,
    url: 'https://example.com/post',
    hostname: 'example.com',
    title: 'My Article',
    excerpt: 'Excerpt summary',
    estimatedMinutes: 5,
    tags: [],
    savedAt: new Date(NOW - 60_000).toISOString(),
    readAt: null,
    skippedCount: 0,
    source: null,
    contentHtml: '<p>Body content</p>',
    wordCount: 1100,
    ...overrides,
  };
}

describe('ReaderHeader', () => {
  it('renders title, hostname, time-ago, reading-time', () => {
    render(<ReaderHeader item={makeDetail()} now={NOW} />);
    const h = screen.getByTestId('reader-header');
    expect(h.textContent).toContain('My Article');
    expect(h.textContent).toContain('example.com');
    expect(h.textContent).toContain('1m ago');
    expect(h.textContent).toContain('5 min read');
  });

  it('shows "done" badge when readAt is set', () => {
    render(
      <ReaderHeader
        item={makeDetail({ readAt: new Date(NOW - 1000).toISOString() })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('reader-header').textContent).toMatch(/done/);
  });

  it('shows excerpt only when no body extracted', () => {
    render(<ReaderHeader item={makeDetail({ contentHtml: null })} now={NOW} />);
    expect(screen.getByTestId('reader-header').textContent).toMatch(/Excerpt summary/);
  });

  it('hides excerpt when body is present', () => {
    render(<ReaderHeader item={makeDetail()} now={NOW} />);
    expect(screen.getByTestId('reader-header').textContent).not.toMatch(/Excerpt summary/);
  });

  it('falls back to URL when title is null', () => {
    render(<ReaderHeader item={makeDetail({ title: null })} now={NOW} />);
    expect(screen.getByTestId('reader-header').textContent).toContain('https://example.com/post');
  });

  it('falls back to URL when hostname is empty', () => {
    render(<ReaderHeader item={makeDetail({ hostname: '', url: 'whatever' })} now={NOW} />);
    expect(screen.getByTestId('reader-header').textContent).toContain('whatever');
  });

  it('omits reading-time when null', () => {
    render(<ReaderHeader item={makeDetail({ estimatedMinutes: null })} now={NOW} />);
    expect(screen.queryByTestId('reader-time')).toBeNull();
  });
});

describe('ReaderBody', () => {
  it('renders the sanitized HTML', () => {
    render(<ReaderBody item={makeDetail()} />);
    expect(screen.getByTestId('reader-body').innerHTML).toContain('<p>Body content</p>');
  });

  it('shows fallback when no body', () => {
    render(<ReaderBody item={makeDetail({ contentHtml: null })} />);
    expect(screen.getByTestId('reader-fallback')).toBeTruthy();
    expect(screen.getByTestId('reader-fallback').textContent).toMatch(/Open original/);
  });
});
