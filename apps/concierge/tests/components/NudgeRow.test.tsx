import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { EmptyNudges, NudgeRow, NudgeRowInner } from '~/components/NudgeRow';
import { appDict } from '~/i18n/dict';
import type { NudgeRow as NudgeRowType } from '~/server/concierge';

const NOW = Date.parse('2026-05-24T12:00:00Z');

function base(overrides: Partial<NudgeRowType> = {}): NudgeRowType {
  return {
    id: 7,
    userId: 1,
    topic: 'inbox-idle',
    question: 'You closed X — try Y next?',
    contextSummary: null,
    model: 'gpt-4o-mini',
    channels: ['push', 'today'],
    sentAt: new Date(NOW - 12 * 60_000).toISOString(),
    openedAt: null,
    dismissedAt: null,
    repliedAt: null,
    replyText: null,
    ...overrides,
  };
}

describe('NudgeRowInner', () => {
  it('renders the question, topic label, and time-ago', () => {
    render(<NudgeRowInner nudge={base()} now={NOW} />);
    const row = screen.getByTestId('nudge-7');
    expect(row.textContent).toContain('You closed X — try Y next?');
    expect(row.textContent).toContain('Inbox idle');
    expect(row.textContent).toContain('12m ago');
    expect(row.dataset.state).toBe('unopened');
  });

  it('reports state=opened when openedAt is set', () => {
    render(<NudgeRowInner nudge={base({ openedAt: new Date(NOW).toISOString() })} now={NOW} />);
    expect(screen.getByTestId('nudge-7').dataset.state).toBe('opened');
  });

  it('reports state=replied when repliedAt + reply text are set', () => {
    render(
      <NudgeRowInner
        nudge={base({
          repliedAt: new Date(NOW).toISOString(),
          replyText: 'on it',
        })}
        now={NOW}
      />,
    );
    const row = screen.getByTestId('nudge-7');
    expect(row.dataset.state).toBe('replied');
    expect(row.textContent).toContain('"on it"');
  });

  it('reports state=dismissed when dismissedAt is set', () => {
    render(
      <NudgeRowInner
        nudge={base({ dismissedAt: new Date(NOW).toISOString() })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('nudge-7').dataset.state).toBe('dismissed');
  });

  it('omits the channels suffix when none are set', () => {
    render(<NudgeRowInner nudge={base({ channels: [] })} now={NOW} />);
    expect(screen.getByTestId('nudge-7').textContent).not.toMatch(/via /);
  });
});

describe('NudgeRow (wrapper)', () => {
  it('wraps the inner row in an <li> so it slots into <ul>', () => {
    const { container } = render(
      <ul>
        <NudgeRow nudge={base()} now={NOW} />
      </ul>,
    );
    const li = container.querySelector('li');
    expect(li).not.toBeNull();
    expect(li!.querySelector('[data-testid="nudge-7"]')).not.toBeNull();
  });
});

describe('EmptyNudges', () => {
  it('shows the cron + manual-trigger copy', () => {
    render(
      <I18nProvider locale="en" dict={appDict}>
        <EmptyNudges />
      </I18nProvider>,
    );
    expect(screen.getByTestId('empty-nudges').textContent).toMatch(/cron/);
    expect(screen.getByTestId('empty-nudges').textContent).toMatch(/enabled = true/);
  });
});
