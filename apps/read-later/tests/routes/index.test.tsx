import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

// Stub Link / useRouter before the route module is imported so JSX doesn't
// try to walk up to a real router context.  All tests below render the pure
// presentational pieces — no real router needed.
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
    useRouter: () => ({ invalidate: () => {}, navigate: () => {} }),
  };
});

import { QueueCard, QueueEmpty, QueueHeader } from '~/routes/index';
import type { ItemSummary } from '~/server/read-later';

const NOW = Date.parse('2026-05-24T12:00:00Z');

function makeItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 7,
    url: 'https://example.com/post',
    hostname: 'example.com',
    title: 'Test Article',
    excerpt: 'A short excerpt about the post.',
    estimatedMinutes: 5,
    tags: ['rust'],
    savedAt: new Date(NOW - 12 * 60_000).toISOString(),
    readAt: null,
    skippedCount: 0,
    source: null,
    ...overrides,
  };
}

describe('QueueCard', () => {
  it('renders title, hostname, time-ago, and reading time', () => {
    render(<QueueCard item={makeItem()} now={NOW} onDone={() => {}} onSkip={() => {}} />);
    const card = screen.getByTestId('queue-card-7');
    expect(card.textContent).toContain('Test Article');
    expect(card.textContent).toContain('example.com');
    expect(card.textContent).toContain('12m ago');
    expect(card.textContent).toContain('5 min read');
    expect(card.textContent).toContain('#rust');
  });

  it('falls back to URL when title is null', () => {
    render(
      <QueueCard
        item={makeItem({ title: null })}
        now={NOW}
        onDone={() => {}}
        onSkip={() => {}}
      />,
    );
    const card = screen.getByTestId('queue-card-7');
    expect(card.textContent).toContain('https://example.com/post');
  });

  it('shows skip-count badge when > 0', () => {
    render(
      <QueueCard
        item={makeItem({ skippedCount: 3 })}
        now={NOW}
        onDone={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByTestId('queue-card-7').textContent).toMatch(/skipped 3 times/);
  });

  it('fires onSkip / onDone callbacks', () => {
    const onSkip = vi.fn();
    const onDone = vi.fn();
    render(<QueueCard item={makeItem()} now={NOW} onDone={onDone} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('skip'));
    fireEvent.click(screen.getByTestId('done'));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('disables buttons when busy', () => {
    render(<QueueCard item={makeItem()} now={NOW} onDone={() => {}} onSkip={() => {}} busy />);
    expect((screen.getByTestId('skip') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('done') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides excerpt when missing', () => {
    render(
      <QueueCard
        item={makeItem({ excerpt: null })}
        now={NOW}
        onDone={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByTestId('queue-card-7').textContent).not.toContain('A short excerpt');
  });

  it('omits reading-time label when estimatedMinutes is null', () => {
    render(
      <QueueCard
        item={makeItem({ estimatedMinutes: null })}
        now={NOW}
        onDone={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.queryByTestId('time-label')).toBeNull();
  });

  it('falls back to "link" when hostname is empty', () => {
    render(
      <QueueCard
        item={makeItem({ hostname: '' })}
        now={NOW}
        onDone={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByTestId('queue-card-7').textContent).toContain('link');
  });
});

describe('QueueEmpty', () => {
  it('shows "queue empty" copy when unreadCount = 0', () => {
    render(<QueueEmpty unreadCount={0} />);
    expect(screen.getByTestId('queue-empty').textContent).toMatch(/queue is empty/);
  });
  it('shows the unread count otherwise', () => {
    render(<QueueEmpty unreadCount={5} />);
    expect(screen.getByTestId('queue-empty').textContent).toMatch(/5 unread items/);
  });
  it('singularises 1 unread', () => {
    render(<QueueEmpty unreadCount={1} />);
    expect(screen.getByTestId('queue-empty').textContent).toMatch(/1 unread item,/);
  });
});

describe('QueueHeader', () => {
  it('shows "inbox zero" when no unread', () => {
    render(<QueueHeader unreadCount={0} />);
    expect(screen.getByTestId('queue-header').textContent).toMatch(/Inbox zero/);
  });
  it('shows count when unread > 0', () => {
    render(<QueueHeader unreadCount={3} />);
    expect(screen.getByTestId('queue-header').textContent).toMatch(/3 unread/);
  });
});
