import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { EventCard } from '~/components/EventCard';
import type { EventRow } from '~/server/dopamine';

const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider locale="en" dict={appDict}>{ui}</I18nProvider>);

const baseEvent: EventRow = {
  id: 1,
  userId: 1,
  kind: 'pr_merged',
  title: 'shipped feat',
  body: null,
  sourceRef: null,
  importance: 1,
  tags: [],
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
};

describe('EventCard', () => {
  it('renders title + kind label', () => {
    render(<ul><EventCard event={baseEvent} /></ul>);
    expect(screen.getByTestId('title-1').textContent).toBe('shipped feat');
    expect(screen.getByTestId('event-1').textContent).toContain('PR merged');
  });

  it('renders body when present', () => {
    render(<ul><EventCard event={{ ...baseEvent, body: 'why it matters' }} /></ul>);
    expect(screen.getByTestId('event-1').textContent).toContain('why it matters');
  });

  it('shows importance label when > 1', () => {
    render(<ul><EventCard event={{ ...baseEvent, importance: 3 }} /></ul>);
    expect(screen.getByTestId('importance-1').textContent).toBe('big');
  });

  it('hides importance label at 1', () => {
    render(<ul><EventCard event={{ ...baseEvent, importance: 1 }} /></ul>);
    expect(screen.queryByTestId('importance-1')).toBeNull();
  });

  it('renders tags', () => {
    render(<ul><EventCard event={{ ...baseEvent, tags: ['work', 'win'] }} /></ul>);
    expect(screen.getByTestId('event-1').textContent).toContain('#work');
    expect(screen.getByTestId('event-1').textContent).toContain('#win');
  });

  it('renders source_ref when present', () => {
    render(<ul><EventCard event={{ ...baseEvent, sourceRef: 'pr#42' }} /></ul>);
    expect(screen.getByTestId('ref-1').textContent).toBe('pr#42');
  });

  it('applies highlight style', () => {
    render(<ul><EventCard event={baseEvent} highlight /></ul>);
    expect(screen.getByTestId('event-1').className).toContain('border-dopamine-700');
  });
});
