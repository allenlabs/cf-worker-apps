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
      params,
      ...rest
    }: {
      children: React.ReactNode;
      to?: string;
      params?: Record<string, string>;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      const href = params
        ? Object.values(params).reduce(
            (p, v) => p.replace(/\$[a-z]+/i, v),
            to ?? '',
          )
        : to ?? '';
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    },
  };
});

import { QueueListEmpty, QueueListRow } from '~/routes/queue';
import type { ItemSummary } from '~/server/read-later';

const NOW = Date.parse('2026-05-24T12:00:00Z');

function makeItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 1,
    url: 'https://example.com/x',
    hostname: 'example.com',
    title: 'Item',
    excerpt: null,
    estimatedMinutes: 3,
    tags: [],
    savedAt: new Date(NOW - 30_000).toISOString(),
    readAt: null,
    skippedCount: 0,
    source: null,
    ...overrides,
  };
}

describe('QueueListRow', () => {
  it('renders title + hostname + time-ago + reading-time', () => {
    render(<QueueListRow item={makeItem()} now={NOW} />);
    const row = screen.getByTestId('row-1');
    expect(row.textContent).toContain('Item');
    expect(row.textContent).toContain('example.com');
    expect(row.textContent).toContain('just now');
    expect(row.textContent).toContain('3 min read');
  });

  it('shows "done" badge for read items', () => {
    render(
      <QueueListRow
        item={makeItem({ readAt: new Date(NOW - 1000).toISOString() })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('row-1').textContent).toMatch(/done/);
  });

  it('falls back to URL when title is null', () => {
    render(<QueueListRow item={makeItem({ title: null })} now={NOW} />);
    expect(screen.getByTestId('row-1').textContent).toContain('https://example.com/x');
  });

  it('renders tags', () => {
    render(<QueueListRow item={makeItem({ tags: ['a', 'b'] })} now={NOW} />);
    expect(screen.getByTestId('row-1').textContent).toContain('#a');
    expect(screen.getByTestId('row-1').textContent).toContain('#b');
  });

  it('omits reading time when null', () => {
    render(<QueueListRow item={makeItem({ estimatedMinutes: null })} now={NOW} />);
    const row = screen.getByTestId('row-1');
    expect(row.textContent).not.toMatch(/min read/);
  });
});

describe('QueueListEmpty', () => {
  it('shows "no items" copy by default', () => {
    render(<QueueListEmpty filtering={false} />);
    expect(screen.getByTestId('list-empty').textContent).toMatch(/No items yet/);
  });
  it('shows "no items match" when filtering', () => {
    render(<QueueListEmpty filtering />);
    expect(screen.getByTestId('list-empty').textContent).toMatch(/No items match/);
  });
});
