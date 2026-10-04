import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { ReminderRowCard } from '~/components/ReminderRow';
import type { ReminderRow as ReminderData } from '~/server/nudge';

const render = (ui: React.ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const NOW = new Date('2026-05-24T10:00:00Z').getTime();

const baseReminder: ReminderData = {
  id: 1,
  userId: 1,
  text: 'drink water',
  fireAt: new Date(NOW + 60 * 60_000).toISOString(),
  nextFireAt: null,
  recurrence: null,
  tags: [],
  createdAt: new Date(NOW - 60_000).toISOString(),
  deliveredAt: null,
  dismissedAt: null,
  snoozedUntil: null,
  source: null,
};

describe('ReminderRowCard', () => {
  it('renders text + when', () => {
    render(<ReminderRowCard reminder={baseReminder} now={NOW} />);
    expect(screen.getByTestId('reminder-text-1').textContent).toBe('drink water');
    expect(screen.getByTestId('reminder-when-1').textContent).toContain('in');
  });

  it('renders recurrence', () => {
    render(
      <ReminderRowCard reminder={{ ...baseReminder, recurrence: 'daily' }} now={NOW} />,
    );
    expect(screen.getByTestId('reminder-recur-1').textContent).toBe('daily');
  });

  it('renders tags', () => {
    render(
      <ReminderRowCard reminder={{ ...baseReminder, tags: ['e2e-test', 'water'] }} now={NOW} />,
    );
    expect(screen.getByTestId('reminder-tag-1-e2e-test')).toBeInTheDocument();
    expect(screen.getByTestId('reminder-tag-1-water')).toBeInTheDocument();
  });

  it('calls onSnooze + onDismiss', () => {
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReminderRowCard reminder={baseReminder} now={NOW} onSnooze={onSnooze} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId('snooze-1'));
    expect(onSnooze).toHaveBeenCalledWith(1, 30);
    fireEvent.click(screen.getByTestId('dismiss-1'));
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('tolerates missing callbacks', () => {
    render(<ReminderRowCard reminder={baseReminder} now={NOW} />);
    fireEvent.click(screen.getByTestId('snooze-1'));
    fireEvent.click(screen.getByTestId('dismiss-1'));
  });
});
